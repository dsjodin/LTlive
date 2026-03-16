"""Flask backend for LTlive - Live bus tracking for Örebro."""

import os
import threading
import time
import traceback

from apscheduler.schedulers.background import BackgroundScheduler
from flask import Flask, jsonify, request
from flask_cors import CORS

import config
import gtfs_loader
import gtfs_rt

app = Flask(__name__)
CORS(app)

# In-memory data store
_stop_seq_cache = {}   # (route_id, dir_id) -> [{"stop_id", "stop_name"}, ...]
_stop_seq_lock = threading.Lock()

_data = {
    "routes": {},
    "stops": {},
    "trips": {},
    "shapes": {},
    "vehicles": [],
    "vehicle_trips": {},
    "vehicle_next_stop": {},
    "alerts": [],
    "trip_headsigns": {},
    "last_vehicle_update": 0,
    "last_rt_poll": 0,
    "last_rt_poll_count": None,
    "last_rt_error": None,
    "gtfs_loaded": False,
    "gtfs_error": None,
}
_lock = threading.Lock()


def _gtfs_data_valid():
    """Check if GTFS data directory has valid extracted data."""
    gtfs_dir = config.GTFS_DATA_DIR
    routes_file = os.path.join(gtfs_dir, "routes.txt")
    if not os.path.exists(routes_file):
        return False
    # Check that routes.txt is non-empty (not a corrupt extract)
    return os.path.getsize(routes_file) > 10


def _clean_gtfs_dir():
    """Remove all files in GTFS data directory for a clean re-download."""
    import glob
    gtfs_dir = config.GTFS_DATA_DIR
    for f in glob.glob(os.path.join(gtfs_dir, "*")):
        try:
            os.remove(f)
        except OSError:
            pass
    print("Cleaned GTFS data directory for fresh download")


def init_gtfs_static():
    """Download and load GTFS static data."""
    try:
        if not config.TRAFIKLAB_GTFS_STATIC_KEY:
            raise ValueError(
                "No GTFS static API key configured. "
                "Set TRAFIKLAB_GTFS_STATIC_KEY or TRAFIKLAB_API_KEY."
            )

        if not _gtfs_data_valid():
            _clean_gtfs_dir()
            gtfs_loader.download_gtfs_static()

        routes = gtfs_loader.load_routes()
        stops = gtfs_loader.load_stops()
        trips = gtfs_loader.load_trips()
        shapes = gtfs_loader.load_shapes()

        if not routes:
            print("GTFS routes empty after load, forcing re-download...")
            _clean_gtfs_dir()
            gtfs_loader.download_gtfs_static()
            routes = gtfs_loader.load_routes()
            stops = gtfs_loader.load_stops()
            trips = gtfs_loader.load_trips()
            shapes = gtfs_loader.load_shapes()

        # Build headsigns and stop->route map in a single pass over stop_times.txt
        print("Building trip headsigns and stop->route map from stop_times...")
        trip_headsigns, stop_route_map = gtfs_loader.load_trip_headsigns_and_stop_route_map(stops, trips)

        with _lock:
            _data["routes"] = routes
            _data["stops"] = stops
            _data["trips"] = trips
            _data["shapes"] = shapes
            _data["trip_headsigns"] = trip_headsigns
            _data["stop_route_map"] = stop_route_map
            _data["gtfs_loaded"] = True
            _data["gtfs_error"] = None

        print(f"GTFS loaded: {len(routes)} routes, {len(stops)} stops, "
              f"{len(trips)} trips, {len(shapes)} shapes, "
              f"{len(trip_headsigns)} trip headsigns")
    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        print(f"Error loading GTFS static data: {error_msg}")
        traceback.print_exc()
        with _lock:
            _data["gtfs_error"] = error_msg


def refresh_gtfs_static():
    """Re-download GTFS static data (scheduled daily)."""
    try:
        _clean_gtfs_dir()
        gtfs_loader.download_gtfs_static()
        routes = gtfs_loader.load_routes()
        stops = gtfs_loader.load_stops()
        trips = gtfs_loader.load_trips()
        shapes = gtfs_loader.load_shapes()

        with _lock:
            _data["routes"] = routes
            _data["stops"] = stops
            _data["trips"] = trips
            _data["shapes"] = shapes
            _data["gtfs_error"] = None

        print("GTFS static data refreshed.")
    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        print(f"Error refreshing GTFS static data: {error_msg}")
        with _lock:
            _data["gtfs_error"] = error_msg


def poll_realtime():
    """Poll GTFS-RT vehicle positions + trip updates."""
    vehicles, rt_error = gtfs_rt.fetch_vehicle_positions()

    # Always record that we polled, even if the feed is empty
    with _lock:
        _data["last_rt_poll"] = int(time.time())
        _data["last_rt_poll_count"] = len(vehicles)
        _data["last_rt_error"] = rt_error

    # Don't overwrite with empty data on fetch failure
    if not vehicles:
        return

    # Fetch trip updates and alerts (non-critical — use cached on failure)
    vehicle_trips, vehicle_next_stop, stop_departures = gtfs_rt.fetch_trip_updates()
    alerts = gtfs_rt.fetch_service_alerts()

    # Merge TripUpdates into vehicles that lack trip info,
    # then resolve route_id via static trips if TripUpdates didn't provide it
    with _lock:
        static_trips = _data["trips"]
        # Keep previous trip mappings if new fetch failed
        if not vehicle_trips:
            vehicle_trips = _data.get("vehicle_trips", {})
        if not vehicle_next_stop:
            vehicle_next_stop = _data.get("vehicle_next_stop", {})

    for v in vehicles:
        vid = v.get("vehicle_id", "")
        tu = vehicle_trips.get(vid, {})

        if not v.get("trip_id") and not v.get("route_id"):
            if tu:
                v["trip_id"] = tu.get("trip_id", "")
                v["route_id"] = tu.get("route_id", "")
                v["direction_id"] = tu.get("direction_id")
                v["start_date"] = tu.get("start_date", "")

        # If we have trip_id but no route_id, look up in static trips
        trip_id = v.get("trip_id", "")
        if trip_id and not v.get("route_id"):
            static_trip = static_trips.get(trip_id, {})
            if static_trip:
                v["route_id"] = static_trip.get("route_id", "")
                v["direction_id"] = v.get("direction_id") or static_trip.get("direction_id")

        # Last resort: if route_id is still missing, use TripUpdate data directly.
        # This handles the case where the VehiclePositions trip_id doesn't match
        # the static GTFS (e.g. different version/format) but TripUpdates has
        # the correct route_id or a trip_id that does match.
        if not v.get("route_id") and tu:
            if tu.get("route_id"):
                v["route_id"] = tu["route_id"]
                if not v.get("trip_id"):
                    v["trip_id"] = tu.get("trip_id", "")
            elif tu.get("trip_id") and tu["trip_id"] != trip_id:
                static_trip2 = static_trips.get(tu["trip_id"], {})
                if static_trip2:
                    v["route_id"] = static_trip2.get("route_id", "")
                    v["trip_id"] = tu["trip_id"]
                    v["direction_id"] = v.get("direction_id") or static_trip2.get("direction_id")

    # Attach next stop id from TripUpdates (more reliable than VehiclePositions stop_id)
    for v in vehicles:
        vid = v.get("vehicle_id", "")
        ns = vehicle_next_stop.get(vid, "") or v.get("current_stop_id", "")
        v["current_stop_id"] = ns

    with _lock:
        _data["vehicles"] = vehicles
        _data["vehicle_trips"] = vehicle_trips
        _data["vehicle_next_stop"] = vehicle_next_stop
        if stop_departures:
            _data["stop_departures"] = stop_departures
        if alerts:
            _data["alerts"] = alerts
        _data["last_vehicle_update"] = int(time.time())


# --- API Routes ---

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "gtfs_loaded": _data["gtfs_loaded"]})


@app.route("/api/status")
def status():
    """Debug endpoint showing data loading status."""
    with _lock:
        return jsonify({
            "gtfs_loaded": _data["gtfs_loaded"],
            "gtfs_error": _data["gtfs_error"],
            "routes_count": len(_data["routes"]),
            "stops_count": len(_data["stops"]),
            "trips_count": len(_data["trips"]),
            "shapes_count": len(_data["shapes"]),
            "vehicles_count": len(_data["vehicles"]),
            "alerts_count": len(_data["alerts"]),
            "last_vehicle_update": _data["last_vehicle_update"],
            "last_rt_poll": _data["last_rt_poll"],
            "last_rt_poll_count": _data["last_rt_poll_count"],
            "last_rt_error": _data["last_rt_error"],
            "operator": config.OPERATOR,
            "has_static_key": bool(config.TRAFIKLAB_GTFS_STATIC_KEY),
            "has_rt_key": bool(config.TRAFIKLAB_GTFS_RT_KEY),
        })


@app.route("/api/debug/matching")
def debug_matching():
    """Debug: show how well vehicle->trip->route matching works."""
    with _lock:
        vehicle_list = list(_data["vehicles"])
        all_routes = _data["routes"]
        trips = _data["trips"]
        vehicle_trips = _data.get("vehicle_trips", {})

    with_route = []
    without_route = []
    trip_match_ok = 0
    trip_match_fail = 0

    for v in vehicle_list:
        vid = v.get("vehicle_id", "")
        trip_id = v.get("trip_id", "")
        route_id = v.get("route_id", "")

        trip_info = trips.get(trip_id, {}) if trip_id else {}
        if trip_info:
            trip_match_ok += 1
        elif trip_id:
            trip_match_fail += 1

        if route_id:
            route_info = all_routes.get(route_id, {})
            with_route.append({
                "vehicle_id": vid,
                "route_id": route_id,
                "route_short_name": route_info.get("route_short_name", ""),
                "trip_id": trip_id,
                "trip_headsign": trip_info.get("trip_headsign", ""),
                "route_long_name": route_info.get("route_long_name", ""),
            })
        else:
            without_route.append({
                "vehicle_id": vid,
                "trip_id": trip_id,
                "route_id_raw": route_id,
            })

    # Show a sample TripUpdate mapping with static trip lookup
    sample_mappings = []
    for vid, tu in list(vehicle_trips.items())[:5]:
        tid = tu.get("trip_id", "")
        static_trip = trips.get(tid, {})
        rid = tu.get("route_id", "")
        route = all_routes.get(rid, {})
        sample_mappings.append({
            "vehicle_id": vid,
            "trip_update_trip_id": tid,
            "trip_update_route_id": rid,
            "static_trip_found": bool(static_trip),
            "static_trip_headsign": static_trip.get("trip_headsign", ""),
            "route_short_name": route.get("route_short_name", ""),
            "route_long_name": route.get("route_long_name", ""),
        })

    return jsonify({
        "total_vehicles": len(vehicle_list),
        "with_route": len(with_route),
        "without_route": len(without_route),
        "trip_id_match_ok": trip_match_ok,
        "trip_id_match_fail": trip_match_fail,
        "total_trip_update_mappings": len(vehicle_trips),
        "sample_with_route": with_route[:5],
        "sample_without_route": without_route[:10],
        "sample_trip_update_mappings": sample_mappings,
        "sample_static_trip_keys": list(trips.keys())[:3],
    })


@app.route("/api/vehicles")
def vehicles():
    """Return current vehicle positions with route info."""
    with _lock:
        vehicle_list = list(_data["vehicles"])
        routes = _data["routes"]
        stops = _data["stops"]
        trips = _data["trips"]
        trip_headsigns = _data["trip_headsigns"]

    enriched = []
    for v in vehicle_list:
        route_info = {}
        trip_id = v.get("trip_id", "")
        trip_info = trips.get(trip_id, {})
        route_id = v.get("route_id") or trip_info.get("route_id", "")
        if route_id:
            route_info = routes.get(route_id, {})

        # Build headsign: trips.txt -> last stop name -> route_long_name
        headsign = trip_info.get("trip_headsign", "")
        if not headsign and trip_id:
            headsign = trip_headsigns.get(trip_id, "")
        if not headsign:
            headsign = route_info.get("route_long_name", "")

        # Resolve next/current stop name from stop_id in the RT feed
        stop_id = v.get("current_stop_id", "")
        next_stop_name = stops.get(stop_id, {}).get("stop_name", "") if stop_id else ""

        enriched.append({
            **v,
            "route_id": route_id,
            "route_short_name": route_info.get("route_short_name", ""),
            "route_long_name": route_info.get("route_long_name", ""),
            "route_color": route_info.get("route_color", "0074D9"),
            "route_text_color": route_info.get("route_text_color", "FFFFFF"),
            "trip_headsign": headsign,
            "next_stop_name": next_stop_name,
        })

    return jsonify({
        "vehicles": enriched,
        "timestamp": _data["last_vehicle_update"],
        "count": len(enriched),
    })


@app.route("/api/routes")
def routes_bus():
    """Return bus routes only."""
    with _lock:
        route_list = list(_data["routes"].values())
    bus_routes = [r for r in route_list
                  if r["route_type"] == 3 or 700 <= r["route_type"] <= 799]
    return jsonify({"routes": bus_routes, "count": len(bus_routes)})


@app.route("/api/routes/all")
def routes_all():
    """Return all routes regardless of type."""
    with _lock:
        route_list = list(_data["routes"].values())
    return jsonify({"routes": route_list, "count": len(route_list)})


@app.route("/api/stops")
def stops():
    """Return stops, optionally filtered by route_ids query param."""
    route_ids_param = request.args.get("route_ids", "")
    with _lock:
        stop_list = list(_data["stops"].values())
        stop_route_map = _data.get("stop_route_map", {})

    if route_ids_param:
        allowed = set(route_ids_param.split(","))
        stop_list = [
            s for s in stop_list
            if allowed.intersection(stop_route_map.get(s["stop_id"], []))
        ]

    return jsonify({"stops": stop_list, "count": len(stop_list)})


@app.route("/api/departures/<stop_id>")
def departures_for_stop(stop_id):
    """Return upcoming departures for a stop, enriched with route info."""
    now = int(time.time())
    limit = min(int(request.args.get("limit", 10)), 30)

    with _lock:
        stop_departures = _data.get("stop_departures", {})
        routes = _data["routes"]
        trips = _data["trips"]
        trip_headsigns = _data.get("trip_headsigns", {})
        raw = stop_departures.get(stop_id, [])

    upcoming = sorted(
        [d for d in raw if d["time"] >= now - 60],
        key=lambda d: d["time"],
    )[:limit]

    result = []
    for d in upcoming:
        route_id = d["route_id"]
        trip_id = d["trip_id"]

        # Try to resolve route from static trips if not in TripUpdate
        if not route_id:
            route_id = trips.get(trip_id, {}).get("route_id", "")

        route = routes.get(route_id, {})
        headsign = trip_headsigns.get(trip_id, "") or route.get("route_long_name", "")

        result.append({
            "route_short_name": route.get("route_short_name", "?"),
            "route_color": route.get("route_color", "0074D9"),
            "route_text_color": route.get("route_text_color", "FFFFFF"),
            "headsign": headsign,
            "departure_time": d["time"],
            "is_realtime": d["is_realtime"],
        })

    return jsonify({"stop_id": stop_id, "departures": result, "count": len(result)})


@app.route("/api/stops/stations")
def stations():
    """Return only parent stations (location_type=1)."""
    with _lock:
        stop_list = list(_data["stops"].values())
    result = [s for s in stop_list if s["location_type"] == 1]
    return jsonify({"stops": result, "count": len(result)})


@app.route("/api/shapes")
def shapes():
    """Return all shapes (route geometries)."""
    with _lock:
        all_shapes = _data["shapes"]
    return jsonify({"shapes": all_shapes, "count": len(all_shapes)})


@app.route("/api/shapes/<route_id>")
def shapes_for_route(route_id):
    """Return shapes for a specific route."""
    with _lock:
        trips = _data["trips"]
        all_shapes = _data["shapes"]

    shape_ids = set()
    for trip in trips.values():
        if trip["route_id"] == route_id and trip["shape_id"]:
            shape_ids.add(trip["shape_id"])

    route_shapes = {sid: all_shapes[sid] for sid in shape_ids if sid in all_shapes}
    return jsonify({"shapes": route_shapes, "route_id": route_id})


@app.route("/api/debug/routes")
def debug_routes():
    """Debug: show all unique route_short_names in loaded GTFS data."""
    with _lock:
        route_list = list(_data["routes"].values())

    by_name = {}
    for r in route_list:
        name = r.get("route_short_name", "")
        by_name.setdefault(name, []).append({
            "route_id": r["route_id"],
            "route_long_name": r.get("route_long_name", ""),
            "route_type": r.get("route_type"),
        })

    return jsonify({
        "total_routes": len(route_list),
        "unique_short_names": sorted(by_name.keys()),
        "by_short_name": by_name,
    })


@app.route("/api/debug/rt-feed")
def debug_rt_feed():
    """Return cached RT feed stats (no extra Trafiklab request)."""
    with _lock:
        vehicles = list(_data["vehicles"])
        vehicle_trips = _data.get("vehicle_trips", {})
        last_poll = _data["last_rt_poll"]
        last_count = _data["last_rt_poll_count"]
        last_error = _data["last_rt_error"]

    sample = []
    for v in vehicles[:5]:
        sample.append({
            "id": v.get("id", ""),
            "vehicle_id": v.get("vehicle_id", ""),
            "lat": v.get("lat"),
            "lon": v.get("lon"),
            "trip_id": v.get("trip_id", ""),
            "route_id": v.get("route_id", ""),
        })

    return jsonify({
        "url_prefix": config.VEHICLE_POSITIONS_URL.split("?")[0],
        "last_poll": last_poll,
        "last_poll_count": last_count,
        "last_error": last_error,
        "cached_vehicles": len(vehicles),
        "sample_vehicles": sample,
        "trip_update_mappings": len(vehicle_trips),
    })


@app.route("/api/alerts")
def alerts():
    """Return current service alerts."""
    with _lock:
        alert_list = _data["alerts"]
    return jsonify({"alerts": alert_list, "count": len(alert_list)})


@app.route("/api/line/<route_id>")
def line_detail(route_id):
    """Return detailed info for a specific route/line."""
    with _lock:
        all_routes = _data["routes"]
        trips = _data["trips"]
        all_shapes = _data["shapes"]
        vehicle_list = _data["vehicles"]

    route = all_routes.get(route_id)
    if not route:
        return jsonify({"error": "Route not found"}), 404

    route_trips = {tid: t for tid, t in trips.items() if t["route_id"] == route_id}
    shape_ids = set(t["shape_id"] for t in route_trips.values() if t["shape_id"])
    route_shapes = {sid: all_shapes[sid] for sid in shape_ids if sid in all_shapes}

    active = [v for v in vehicle_list
              if v.get("route_id") == route_id
              or trips.get(v.get("trip_id", ""), {}).get("route_id") == route_id]

    return jsonify({
        "route": route,
        "shapes": route_shapes,
        "active_vehicles": active,
        "trip_count": len(route_trips),
    })


def _parse_gtfs_time_secs(time_str):
    """Parse GTFS time string 'HH:MM:SS' (may exceed 24h) to seconds from midnight."""
    if not time_str:
        return None
    try:
        parts = time_str.split(":")
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except (IndexError, ValueError):
        return None


def _get_stop_sequence(route_id, direction_id):
    """Return ordered stops for a route+direction, loading from stop_times if needed."""
    key = (route_id, direction_id)
    with _stop_seq_lock:
        if key in _stop_seq_cache:
            return _stop_seq_cache[key]

    with _lock:
        trips = _data["trips"]
        stops = _data["stops"]

    # Find one representative trip for this route+direction
    rep_trip = next(
        (tid for tid, t in trips.items()
         if t.get("route_id") == route_id
         and str(t.get("direction_id", "0") or "0") == direction_id),
        None,
    )
    if not rep_trip:
        return []

    trip_data = gtfs_loader.load_stop_times_for_trips({rep_trip})
    seq = [
        {
            "stop_id": s["stop_id"],
            "stop_name": stops.get(s["stop_id"], {}).get("stop_name", s["stop_id"]),
            "departure_time": s.get("departure_time", "") or s.get("arrival_time", ""),
        }
        for s in trip_data.get(rep_trip, [])
    ]

    with _stop_seq_lock:
        _stop_seq_cache[key] = seq
    return seq


@app.route("/api/line-departures/<route_id>")
def line_departures(route_id):
    """Return stop-by-stop timetable for each direction of a route."""
    with _lock:
        stop_departures = dict(_data.get("stop_departures", {}))
        trip_headsigns = _data["trip_headsigns"]
        routes = _data["routes"]
        stops = _data["stops"]
        trips = _data["trips"]
        now = int(time.time())

    # Build per-trip RT stop times: trip_id -> {dir, stop_id -> (unix_time, is_rt)}
    trip_rt = {}
    for stop_id, deps in stop_departures.items():
        for dep in deps:
            tid = dep.get("trip_id", "")
            if not tid:
                continue
            static = trips.get(tid, {})
            r = static.get("route_id") or dep.get("route_id", "")
            if r != route_id:
                continue
            t = dep.get("time", 0)
            # direction_id: prefer RT-provided (always int, 0 is valid), fall back to static
            rt_dir = dep.get("direction_id")
            if rt_dir is not None:
                dir_id = str(rt_dir)
            else:
                dir_id = str(static.get("direction_id", "0") or "0")
            if tid not in trip_rt:
                trip_rt[tid] = {"dir": dir_id, "stop_times": {}}
            existing = trip_rt[tid]["stop_times"].get(stop_id)
            if existing is None or t < existing[0]:
                trip_rt[tid]["stop_times"][stop_id] = (t, dep.get("is_realtime", False))

    # Per direction: pick trip with earliest upcoming stop
    dir_best = {}  # dir_id -> (trip_id, earliest_future_t)
    for tid, td in trip_rt.items():
        future = [t for t, _ in td["stop_times"].values() if t >= now]
        if not future:
            continue
        first_t = min(future)
        dir_id = td["dir"]
        if dir_id not in dir_best or first_t < dir_best[dir_id][1]:
            dir_best[dir_id] = (tid, first_t)

    directions_out = []
    for dir_id in sorted(dir_best.keys()):
        tid, _ = dir_best[dir_id]
        rt_times = trip_rt[tid]["stop_times"]  # stop_id -> (unix_t, is_rt)

        # Get full static stop sequence (cached) for correct order + scheduled times
        seq = _get_stop_sequence(route_id, dir_id)

        if seq:
            # Compute service midnight: find a stop with both RT time and static time
            service_midnight = None
            for ss in seq:
                sid = ss["stop_id"]
                if sid in rt_times:
                    rt_t = rt_times[sid][0]
                    static_secs = _parse_gtfs_time_secs(ss.get("departure_time", ""))
                    if static_secs is not None:
                        approx = rt_t - static_secs
                        service_midnight = round(approx / 86400) * 86400
                        break

            stops_out = []
            for ss in seq:
                sid = ss["stop_id"]
                if sid in rt_times:
                    t, is_rt = rt_times[sid]
                    if t < now:
                        continue
                    stops_out.append({
                        "stop_id": sid,
                        "stop_name": ss["stop_name"],
                        "time": t,
                        "minutes": max(0, round((t - now) / 60)),
                        "is_realtime": is_rt,
                    })
                elif service_midnight is not None:
                    static_secs = _parse_gtfs_time_secs(ss.get("departure_time", ""))
                    if static_secs is None:
                        continue
                    t = service_midnight + static_secs
                    if t < now:
                        continue
                    stops_out.append({
                        "stop_id": sid,
                        "stop_name": ss["stop_name"],
                        "time": t,
                        "minutes": max(0, round((t - now) / 60)),
                        "is_realtime": False,
                    })
        else:
            # No static sequence: sort RT stops by time
            stops_out = [
                {
                    "stop_id": sid,
                    "stop_name": stops.get(sid, {}).get("stop_name", sid),
                    "time": t,
                    "minutes": max(0, round((t - now) / 60)),
                    "is_realtime": is_rt,
                }
                for sid, (t, is_rt) in sorted(rt_times.items(), key=lambda x: x[1][0])
                if t >= now
            ]

        if stops_out:
            directions_out.append({
                "direction_id": dir_id,
                "headsign": trip_headsigns.get(tid, ""),
                "stops": stops_out,
            })

    route_info = routes.get(route_id, {})
    return jsonify({
        "route_id": route_id,
        "route_short_name": route_info.get("route_short_name", ""),
        "route_long_name": route_info.get("route_long_name", ""),
        "route_color": route_info.get("route_color", "0074D9"),
        "route_text_color": route_info.get("route_text_color", "FFFFFF"),
        "directions": directions_out,
    })


@app.route("/api/stops/next-departure")
def stops_next_departure():
    """Return the soonest upcoming departure per stop (used for map badges)."""
    with _lock:
        stop_departures = dict(_data.get("stop_departures", {}))
        routes = _data["routes"]
        trips = _data["trips"]
        now = int(time.time())
    horizon = now + 3 * 3600  # only look 3 hours ahead

    result = {}
    for stop_id, deps in stop_departures.items():
        best = None
        for dep in deps:
            t = dep.get("time", 0)
            if t < now or t > horizon:
                continue
            if best is None or t < best["time"]:
                # Resolve route via static trips if RT route_id is missing/wrong
                dep_route_id = dep.get("route_id", "")
                ri = routes.get(dep_route_id, {})
                if not ri:
                    static_route_id = trips.get(dep.get("trip_id", ""), {}).get("route_id", "")
                    ri = routes.get(static_route_id, {})
                best = {
                    "time": t,
                    "minutes": max(0, round((t - now) / 60)),
                    "route_short_name": ri.get("route_short_name", ""),
                    "route_color": ri.get("route_color", "0074D9"),
                    "route_text_color": ri.get("route_text_color", "FFFFFF"),
                }
        if best:
            result[stop_id] = best

    return jsonify(result)


# --- Startup ---

def start_background_tasks():
    """Initialize GTFS data and start polling."""
    threading.Thread(target=init_gtfs_static, daemon=True).start()

    scheduler = BackgroundScheduler()
    scheduler.add_job(poll_realtime, "interval", seconds=config.RT_POLL_SECONDS,
                      max_instances=1)
    scheduler.add_job(refresh_gtfs_static, "interval",
                      hours=config.GTFS_REFRESH_HOURS, max_instances=1)
    # Retry GTFS static loading every 60s if it failed
    scheduler.add_job(_retry_gtfs_if_needed, "interval", seconds=60, max_instances=1)
    scheduler.start()

    threading.Thread(target=poll_realtime, daemon=True).start()


def _retry_gtfs_if_needed():
    """Retry loading GTFS static if it previously failed."""
    with _lock:
        if _data["gtfs_loaded"] and _data["routes"]:
            return  # Already loaded successfully
    print("GTFS static data not loaded yet, retrying...")
    init_gtfs_static()


start_background_tasks()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
