"""Bus data provider — GTFS static + GTFS-RT pipeline.

Owns:
  - Downloading and parsing GTFS static data (routes, stops, trips, shapes, timetables)
  - Polling the GTFS-RT feeds (VehiclePositions, TripUpdates, ServiceAlerts)
  - Writing results to data/gtfs_store.py and data/vehicle_store.py

Nothing in this file touches train-specific logic.
"""

import glob as _glob
import os
import time
import traceback

import config
import gtfs_loader
import gtfs_rt
from stores.cache import api_cache
from stores.gtfs_store import gtfs_store
from stores.vehicle_store import vehicle_store


# ---------------------------------------------------------------------------
# GTFS static helpers
# ---------------------------------------------------------------------------

def _gtfs_data_valid() -> bool:
    """Check if GTFS data directory has valid extracted data."""
    routes_file = os.path.join(config.GTFS_DATA_DIR, "routes.txt")
    if not os.path.exists(routes_file):
        return False
    return os.path.getsize(routes_file) > 10


def _clean_gtfs_dir() -> None:
    """Remove all files in GTFS data directory for a clean re-download."""
    for f in _glob.glob(os.path.join(config.GTFS_DATA_DIR, "*")):
        try:
            os.remove(f)
        except OSError:
            pass
    print("Cleaned GTFS data directory for fresh download")


def init_gtfs_static() -> None:
    """Download and load GTFS static data into gtfs_store."""
    try:
        if not config.TRAFIKLAB_GTFS_STATIC_KEY:
            raise ValueError(
                "No GTFS static API key configured. "
                "Set TRAFIKLAB_GTFS_STATIC_KEY or TRAFIKLAB_API_KEY."
            )

        if not _gtfs_data_valid():
            _clean_gtfs_dir()
            gtfs_loader.download_gtfs_static()

        agencies = gtfs_loader.load_agencies()
        routes   = gtfs_loader.load_routes()
        stops    = gtfs_loader.load_stops()
        trips    = gtfs_loader.load_trips()
        shapes   = gtfs_loader.load_shapes()

        if not routes:
            print("GTFS routes empty after load, forcing re-download...")
            _clean_gtfs_dir()
            gtfs_loader.download_gtfs_static()
            agencies = gtfs_loader.load_agencies()
            routes   = gtfs_loader.load_routes()
            stops    = gtfs_loader.load_stops()
            trips    = gtfs_loader.load_trips()
            shapes   = gtfs_loader.load_shapes()

        print("Building trip headsigns, stop->route map and static departures from stop_times...")
        trip_headsigns, stop_route_map, static_stop_departures, static_stop_arrivals, trip_origin_map = (
            gtfs_loader.load_trip_headsigns_and_stop_route_map(stops, trips)
        )

        gtfs_store.update_snapshot({
            "routes":                 routes,
            "stops":                  stops,
            "trips":                  trips,
            "shapes":                 shapes,
            "trip_headsigns":         trip_headsigns,
            "stop_route_map":         stop_route_map,
            "static_stop_departures": static_stop_departures,
            "static_stop_arrivals":   static_stop_arrivals,
            "trip_origin_map":        trip_origin_map,
        })
        with gtfs_store.lock:
            gtfs_store.agencies = agencies

        active_services = gtfs_loader.active_service_ids_today()
        active_trip_count = sum(
            1 for t in trips.values()
            if t.get("service_id", "") in active_services
        )
        print(
            f"GTFS loaded: {len(routes)} routes, {len(stops)} stops, "
            f"{len(trips)} trips ({active_trip_count} active today), {len(shapes)} shapes, "
            f"{len(trip_headsigns)} trip headsigns, "
            f"{len(static_stop_departures)} stops with static departures today"
        )

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        print(f"Error loading GTFS static data: {error_msg}")
        traceback.print_exc()
        gtfs_store.set_error(error_msg)
        return

    if config.TRAFFIC_ENABLED:
        try:
            from traffic_inference import build_segments, load_baseline
            build_segments()  # runs in background thread
            load_baseline()
        except Exception as e:
            print(f"Traffic inference init error: {e}")


def refresh_gtfs_static() -> None:
    """Re-download GTFS static data (scheduled every GTFS_REFRESH_HOURS)."""
    try:
        _clean_gtfs_dir()
        gtfs_loader.download_gtfs_static()
        agencies = gtfs_loader.load_agencies()
        routes   = gtfs_loader.load_routes()
        stops    = gtfs_loader.load_stops()
        trips    = gtfs_loader.load_trips()
        shapes   = gtfs_loader.load_shapes()
        trip_headsigns, stop_route_map, static_stop_departures, static_stop_arrivals, trip_origin_map = (
            gtfs_loader.load_trip_headsigns_and_stop_route_map(stops, trips)
        )

        gtfs_store.update_snapshot({
            "routes":                 routes,
            "stops":                  stops,
            "trips":                  trips,
            "shapes":                 shapes,
            "trip_headsigns":         trip_headsigns,
            "stop_route_map":         stop_route_map,
            "static_stop_departures": static_stop_departures,
            "static_stop_arrivals":   static_stop_arrivals,
            "trip_origin_map":        trip_origin_map,
        })
        with gtfs_store.lock:
            gtfs_store.agencies = agencies

        api_cache.clear()
        print("GTFS static data refreshed.")

        if config.TRAFFIC_ENABLED:
            from traffic_inference import build_segments
            build_segments()

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        print(f"Error refreshing GTFS static data: {error_msg}")
        gtfs_store.set_error(error_msg)


def refresh_static_departures() -> None:
    """Reload today's static departures without re-downloading the GTFS zip.

    Called daily at midnight so departure badges reflect the new timetable day.
    """
    try:
        with gtfs_store.lock:
            trips = dict(gtfs_store.trips)
            stops = dict(gtfs_store.stops)
        if not trips:
            return
        _, _, static_stop_departures, static_stop_arrivals, trip_origin_map = (
            gtfs_loader.load_trip_headsigns_and_stop_route_map(stops, trips)
        )
        with gtfs_store.lock:
            gtfs_store.static_stop_departures = static_stop_departures
            gtfs_store.static_stop_arrivals   = static_stop_arrivals
            gtfs_store.trip_origin_map        = trip_origin_map
        print(f"Static departures refreshed: {len(static_stop_departures)} stops with service today")
    except Exception as e:
        print(f"Error refreshing static departures: {e}")


# ---------------------------------------------------------------------------
# GTFS retry (used by scheduler)
# ---------------------------------------------------------------------------

_gtfs_retry_count = 0
_gtfs_next_retry_at = 0  # epoch seconds; 0 = retry immediately


def retry_gtfs_if_needed() -> None:
    """Retry loading GTFS static with exponential backoff, max 5 attempts."""
    global _gtfs_retry_count, _gtfs_next_retry_at

    with gtfs_store.lock:
        if gtfs_store.loaded and gtfs_store.routes:
            return

    MAX_RETRIES = 5
    if _gtfs_retry_count >= MAX_RETRIES:
        return

    now = time.time()
    if now < _gtfs_next_retry_at:
        return

    _gtfs_retry_count += 1
    delay = min(60 * (2 ** (_gtfs_retry_count - 1)), 3600)
    _gtfs_next_retry_at = now + delay
    print(f"GTFS static not loaded, retry {_gtfs_retry_count}/{MAX_RETRIES} "
          f"(next attempt in {delay}s if this fails)...")
    init_gtfs_static()
    with gtfs_store.lock:
        if gtfs_store.loaded:
            _gtfs_retry_count = 0


# ---------------------------------------------------------------------------
# GTFS-RT polling
# ---------------------------------------------------------------------------

def poll_realtime(push_alerts_callback=None) -> None:
    """Poll GTFS-RT vehicle positions + trip updates.

    Args:
        push_alerts_callback: Optional callable(alerts) to push alerts via SSE.
                              Injected by the scheduler to avoid circular import.
    """
    vehicles, rt_error = gtfs_rt.fetch_vehicle_positions()

    with vehicle_store.lock:
        vehicle_store.last_rt_poll       = int(time.time())
        vehicle_store.last_rt_poll_count = len(vehicles)
        vehicle_store.last_rt_error      = rt_error

    if not vehicles:
        return

    vehicle_trips, vehicle_next_stop, stop_departures, rt_trip_short_names = gtfs_rt.fetch_trip_updates()
    alerts = gtfs_rt.fetch_service_alerts()

    with gtfs_store.lock:
        static_trips = dict(gtfs_store.trips)

    with vehicle_store.lock:
        if not vehicle_trips:
            vehicle_trips = dict(vehicle_store.vehicle_trips)
        if not vehicle_next_stop:
            vehicle_next_stop = dict(vehicle_store.vehicle_next_stop)

    # Resolve route_id via static trips for vehicles that lack it
    for v in vehicles:
        vid = v.get("vehicle_id", "")
        tu  = vehicle_trips.get(vid, {})

        if not v.get("trip_id") and not v.get("route_id"):
            if tu:
                v["trip_id"]      = tu.get("trip_id", "")
                v["route_id"]     = tu.get("route_id", "")
                v["direction_id"] = tu.get("direction_id")
                v["start_date"]   = tu.get("start_date", "")

        trip_id = v.get("trip_id", "")
        if trip_id and not v.get("route_id"):
            static_trip = static_trips.get(trip_id, {})
            if static_trip:
                v["route_id"]     = static_trip.get("route_id", "")
                v["direction_id"] = v.get("direction_id") or static_trip.get("direction_id")

        if not v.get("route_id") and tu:
            if tu.get("route_id"):
                v["route_id"] = tu["route_id"]
                if not v.get("trip_id"):
                    v["trip_id"] = tu.get("trip_id", "")
            elif tu.get("trip_id") and tu["trip_id"] != trip_id:
                static_trip2 = static_trips.get(tu["trip_id"], {})
                if static_trip2:
                    v["route_id"]     = static_trip2.get("route_id", "")
                    v["trip_id"]      = tu["trip_id"]
                    v["direction_id"] = v.get("direction_id") or static_trip2.get("direction_id")

    for v in vehicles:
        vid = v.get("vehicle_id", "")
        ns  = vehicle_next_stop.get(vid, "") or v.get("current_stop_id", "")
        v["current_stop_id"] = ns
        delay_sec = vehicle_trips.get(vid, {}).get("delay_seconds")
        if delay_sec is not None:
            v["delay_seconds"] = delay_sec

    with vehicle_store.lock:
        vehicle_store.vehicles             = vehicles
        vehicle_store.vehicle_trips        = vehicle_trips
        vehicle_store.vehicle_next_stop    = vehicle_next_stop
        vehicle_store.last_vehicle_update  = int(time.time())
        if stop_departures:
            vehicle_store.stop_departures  = stop_departures
        if rt_trip_short_names:
            vehicle_store.rt_trip_short_names = rt_trip_short_names  # stored on gtfs_store below
        if alerts:
            vehicle_store.alerts           = alerts

    # rt_trip_short_names belongs conceptually to gtfs context; keep on gtfs_store too
    if rt_trip_short_names:
        with gtfs_store.lock:
            gtfs_store.rt_trip_short_names = rt_trip_short_names

    api_cache.invalidate("vehicles")
    api_cache.invalidate("next_dep")
    api_cache.invalidate_prefix("dep")

    if config.TRAFFIC_ENABLED:
        try:
            from traffic_inference import process_vehicle_positions
            from tasks.sse_tasks import push_traffic_update
            process_vehicle_positions(vehicles, vehicle_trips)
            push_traffic_update()
        except Exception as e:
            print(f"Traffic inference error: {e}")

    if alerts and push_alerts_callback:
        push_alerts_callback(alerts)
