"""Flask backend for LTlive - Live bus tracking for Örebro."""

import json
import math
import os
import queue as _queue
import threading
import time
import traceback
from functools import wraps

from dotenv import load_dotenv
load_dotenv()

from apscheduler.schedulers.background import BackgroundScheduler
from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS

import config
import gtfs_loader
import gtfs_rt
import oxyfi
import stats as _stats

app = Flask(__name__)

# Restrict CORS to explicitly configured origins (default: none — all traffic is same-origin in prod).
# Set ALLOWED_ORIGINS=https://yourdomain.com for dev/multi-origin setups.
_allowed_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
CORS(app, resources={r"/api/*": {"origins": _allowed_origins or [], "methods": ["GET", "POST"]}})

# Debug endpoints are disabled by default; set ENABLE_DEBUG_ENDPOINTS=true to enable locally.
_DEBUG_ENDPOINTS = os.environ.get("ENABLE_DEBUG_ENDPOINTS", "false").lower() in ("true", "1", "yes")


def _debug_only(f):
    """Decorator: return 404 unless ENABLE_DEBUG_ENDPOINTS=true."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not _DEBUG_ENDPOINTS:
            return jsonify({"error": "Not found"}), 404
        return f(*args, **kwargs)
    return wrapper


_stats.init_db()

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
    "static_stop_departures": {},
}
_lock = threading.Lock()
_gtfs_retry_count = 0
_gtfs_next_retry_at = 0  # epoch seconds; 0 = retry immediately

# SSE client registry: each connected client has a Queue
_sse_clients = []
_sse_clients_lock = threading.Lock()

# Per-IP SSE connection counter (DoS protection)
_sse_ip_counts: dict[str, int] = {}
_sse_ip_lock = threading.Lock()
_MAX_SSE_PER_IP = 4

# Response cache: key -> (payload_dict, last_vehicle_update_when_cached)
_api_cache = {}
_api_cache_lock = threading.Lock()

_RT_STATIC_WINDOW = 20 * 60  # seconds — static entry within this window of an RT entry = same trip


def _merge_rt_static(rt_deps, static_deps):
    """Merge RT and static departures for one stop.

    RT entries take precedence.  A static entry is suppressed if:
      - its trip_id matches an RT entry, OR
      - its scheduled time is within _RT_STATIC_WINDOW seconds of any RT
        departure (handles delayed/early trips where the GTFS-RT trip_id or
        route_id format differs from the static GTFS data).
    """
    if not rt_deps:
        return list(static_deps)

    rt_trip_ids = {d["trip_id"] for d in rt_deps}
    rt_times = [d["time"] for d in rt_deps]

    filtered_static = []
    for dep in static_deps:
        if dep["trip_id"] in rt_trip_ids:
            continue
        dep_time = dep["time"]
        if any(abs(dep_time - rt_time) <= _RT_STATIC_WINDOW for rt_time in rt_times):
            continue
        filtered_static.append(dep)

    return rt_deps + filtered_static


def _cache_get(key):
    with _api_cache_lock:
        entry = _api_cache.get(key)
    if entry is None:
        return None
    payload, cached_at = entry
    with _lock:
        if _data["last_vehicle_update"] != cached_at:
            return None
    return payload


def _cache_set(key, payload):
    with _lock:
        ts = _data["last_vehicle_update"]
    with _api_cache_lock:
        _api_cache[key] = (payload, ts)


def _invalidate_cache():
    with _api_cache_lock:
        _api_cache.clear()


def _enrich_vehicles(vehicle_list):
    """Enrich vehicle list with route/trip/stop info (extracted for reuse by SSE + HTTP)."""
    with _lock:
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

        headsign = trip_info.get("trip_headsign", "")
        if not headsign and trip_id:
            headsign = trip_headsigns.get(trip_id, "")
        if not headsign:
            headsign = route_info.get("route_long_name", "")

        stop_id = v.get("current_stop_id", "")
        next_stop = stops.get(stop_id, {}) if stop_id else {}
        next_stop_name = next_stop.get("stop_name", "")
        next_stop_platform = next_stop.get("platform_code", "")

        enriched.append({
            **v,
            "route_id": route_id,
            "route_short_name": route_info.get("route_short_name", ""),
            "route_long_name": route_info.get("route_long_name", ""),
            "route_color": route_info.get("route_color", "0074D9"),
            "route_text_color": route_info.get("route_text_color", "FFFFFF"),
            "trip_headsign": headsign,
            "next_stop_name": next_stop_name,
            "next_stop_platform": next_stop_platform,
        })
    return enriched


def _push_sse(event_type, data):
    """Push an SSE event to all connected clients."""
    msg = f"event: {event_type}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
    dead = []
    with _sse_clients_lock:
        clients = list(_sse_clients)
    for q in clients:
        try:
            q.put_nowait(msg)
        except _queue.Full:
            dead.append(q)
    if dead:
        with _sse_clients_lock:
            for q in dead:
                try:
                    _sse_clients.remove(q)
                except ValueError:
                    pass


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

        # Build headsigns, stop->route map and today's static departures in one pass
        print("Building trip headsigns, stop->route map and static departures from stop_times...")
        trip_headsigns, stop_route_map, static_stop_departures = (
            gtfs_loader.load_trip_headsigns_and_stop_route_map(stops, trips)
        )

        with _lock:
            _data["routes"] = routes
            _data["stops"] = stops
            _data["trips"] = trips
            _data["shapes"] = shapes
            _data["trip_headsigns"] = trip_headsigns
            _data["stop_route_map"] = stop_route_map
            _data["static_stop_departures"] = static_stop_departures
            _data["gtfs_loaded"] = True
            _data["gtfs_error"] = None

        print(f"GTFS loaded: {len(routes)} routes, {len(stops)} stops, "
              f"{len(trips)} trips, {len(shapes)} shapes, "
              f"{len(trip_headsigns)} trip headsigns, "
              f"{len(static_stop_departures)} stops with static departures today")
    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}"
        print(f"Error loading GTFS static data: {error_msg}")
        traceback.print_exc()
        with _lock:
            _data["gtfs_error"] = error_msg


def _refresh_static_departures():
    """Reload today's static departures without re-downloading the GTFS zip.

    Called daily at midnight so badges reflect the new timetable day.
    """
    try:
        with _lock:
            trips = _data.get("trips", {})
            stops = _data.get("stops", {})
        if not trips:
            return
        _, _, static_stop_departures = (
            gtfs_loader.load_trip_headsigns_and_stop_route_map(stops, trips)
        )
        with _lock:
            _data["static_stop_departures"] = static_stop_departures
        print(f"Static departures refreshed: {len(static_stop_departures)} stops with service today")
    except Exception as e:
        print(f"Error refreshing static departures: {e}")


def refresh_gtfs_static():
    """Re-download GTFS static data (scheduled every GTFS_REFRESH_HOURS)."""
    try:
        _clean_gtfs_dir()
        gtfs_loader.download_gtfs_static()
        routes = gtfs_loader.load_routes()
        stops = gtfs_loader.load_stops()
        trips = gtfs_loader.load_trips()
        shapes = gtfs_loader.load_shapes()
        _, _, static_stop_departures = (
            gtfs_loader.load_trip_headsigns_and_stop_route_map(stops, trips)
        )

        with _lock:
            _data["routes"] = routes
            _data["stops"] = stops
            _data["trips"] = trips
            _data["shapes"] = shapes
            _data["static_stop_departures"] = static_stop_departures
            _data["gtfs_error"] = None
        # Invalidate stop-sequence cache so it is rebuilt with fresh trip data
        with _stop_seq_lock:
            _stop_seq_cache.clear()

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

    _invalidate_cache()

    enriched = _enrich_vehicles(vehicles)
    _push_sse("vehicles", {"vehicles": enriched,
                            "timestamp": _data["last_vehicle_update"],
                            "count": len(enriched)})
    if alerts:
        _push_sse("alerts", {"alerts": alerts, "count": len(alerts)})


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
            "nearby_radius_meters": config.NEARBY_RADIUS_METERS,
            "frontend_poll_interval_ms": config.FRONTEND_POLL_INTERVAL_MS,
            "operator": config.OPERATOR,
            "has_static_key": bool(config.TRAFIKLAB_GTFS_STATIC_KEY),
            "has_rt_key": bool(config.TRAFIKLAB_GTFS_RT_KEY),
        })


@app.route("/api/debug/matching")
@_debug_only
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
    """Return current vehicle positions with route info (buses + trains)."""
    cached = _cache_get("vehicles")
    if cached:
        return jsonify(cached)

    with _lock:
        vehicle_list = list(_data["vehicles"])
        ts = _data["last_vehicle_update"]

    enriched = _enrich_vehicles(vehicle_list) + oxyfi.get_trains()
    result = {"vehicles": enriched, "timestamp": ts, "count": len(enriched)}
    _cache_set("vehicles", result)
    return jsonify(result)


@app.route("/api/routes")
def routes_bus():
    """Return bus routes only."""
    with _lock:
        route_list = list(_data["routes"].values())
    bus_routes = [r for r in route_list
                  if r["route_type"] == 3 or 700 <= r["route_type"] <= 799]
    return jsonify({"routes": bus_routes, "count": len(bus_routes)})


@app.route("/api/routes/trains")
def routes_trains():
    """Return train routes only (GTFS route_type 2 = rail, or 100–199)."""
    with _lock:
        route_list = list(_data["routes"].values())
    train_routes = [r for r in route_list
                    if r["route_type"] == 2 or 100 <= r["route_type"] <= 199]
    return jsonify({"routes": train_routes, "count": len(train_routes)})


@app.route("/api/routes/all")
def routes_all():
    """Return all routes regardless of type."""
    with _lock:
        route_list = list(_data["routes"].values())
    return jsonify({"routes": route_list, "count": len(route_list)})


@app.route("/api/stops")
def stops():
    """Return stops, optionally filtered by route_ids query param."""
    route_ids_param = request.args.get("route_ids", "")[:500]  # cap length
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


@app.route("/api/nearby-departures")
def nearby_departures():
    """Return upcoming departures for stops within radius of a lat/lon position."""
    try:
        lat = float(request.args.get("lat", 0))
        lon = float(request.args.get("lon", 0))
        radius = max(50.0, min(float(request.args.get("radius", config.NEARBY_RADIUS_METERS)), 5000))
    except ValueError:
        return jsonify({"error": "Invalid params"}), 400

    with _lock:
        all_stops = dict(_data["stops"])
        rt_stop_departures = dict(_data.get("stop_departures", {}))
        static_stop_departures = dict(_data.get("static_stop_departures", {}))
        routes = dict(_data["routes"])
        trips = dict(_data["trips"])
        trip_headsigns = dict(_data.get("trip_headsigns", {}))

    now = int(time.time())
    lat_r = math.radians(lat)
    cos_lat = math.cos(lat_r)

    nearby = []
    for stop_id, stop in all_stops.items():
        # Skip station containers and other non-boarding locations
        if stop.get("location_type", 0) != 0:
            continue
        slat = stop.get("stop_lat")
        slon = stop.get("stop_lon")
        if not slat or not slon:
            continue
        dlat = math.radians(slat - lat)
        dlon = math.radians(slon - lon)
        a = math.sin(dlat / 2) ** 2 + cos_lat * math.cos(math.radians(slat)) * math.sin(dlon / 2) ** 2
        dist = 2 * 6371000 * math.asin(math.sqrt(a))
        if dist <= radius:
            nearby.append((dist, stop_id, stop))

    nearby.sort()

    # Group platforms that share the same parent station so "Slottet A" and
    # "Slottet B" appear as a single entry with merged departures.
    groups = {}  # group_key -> {dist, stop, stop_ids}
    for dist, stop_id, stop in nearby:
        group_key = stop.get("parent_station") or stop_id
        if group_key not in groups:
            groups[group_key] = {"dist": dist, "stop": stop, "stop_ids": []}
        groups[group_key]["stop_ids"].append(stop_id)
        if dist < groups[group_key]["dist"]:
            groups[group_key]["dist"] = dist
            groups[group_key]["stop"] = stop

    sorted_groups = sorted(groups.values(), key=lambda g: g["dist"])[:8]

    result = []
    for grp in sorted_groups:
        # Collect and deduplicate departures across all stops in the group (RT + static fallback)
        all_raw = []
        for sid in grp["stop_ids"]:
            all_raw.extend(_merge_rt_static(
                rt_stop_departures.get(sid, []),
                static_stop_departures.get(sid, []),
            ))
        seen_trips = set()
        upcoming = []
        for d in sorted([d for d in all_raw if d["time"] >= now - 60], key=lambda d: d["time"]):
            if d["trip_id"] not in seen_trips:
                seen_trips.add(d["trip_id"])
                upcoming.append(d)
            if len(upcoming) >= 5:
                break
        deps = []
        for d in upcoming:
            route_id = d["route_id"] or trips.get(d["trip_id"], {}).get("route_id", "")
            route = routes.get(route_id, {})
            headsign = trip_headsigns.get(d["trip_id"], "") or route.get("route_long_name", "")
            deps.append({
                "route_short_name": route.get("route_short_name", "?"),
                "route_color": route.get("route_color", "555555"),
                "route_text_color": route.get("route_text_color", "ffffff"),
                "headsign": headsign,
                "departure_time": d["time"],
                "minutes": max(0, round((d["time"] - now) / 60)),
                "is_realtime": d.get("is_realtime", False),
            })
        s = grp["stop"]
        result.append({
            "stop_id": s["stop_id"],
            "stop_name": s.get("stop_name", s["stop_id"]),
            "platform_code": s.get("platform_code", ""),
            "stop_desc": s.get("stop_desc", ""),
            "distance_m": round(grp["dist"]),
            "departures": deps,
        })

    return jsonify({"stops": result})


@app.route("/api/departures/<stop_id>")
def departures_for_stop(stop_id):
    """Return upcoming departures for a stop, enriched with route info."""
    limit = max(1, min(int(request.args.get("limit", 10)), 30))
    cache_key = ("dep", stop_id, limit)
    cached = _cache_get(cache_key)
    if cached:
        return jsonify(cached)

    now = int(time.time())
    with _lock:
        rt_deps = _data.get("stop_departures", {}).get(stop_id, [])
        static_deps = _data.get("static_stop_departures", {}).get(stop_id, [])
        routes = _data["routes"]
        trips = _data["trips"]
        trip_headsigns = _data.get("trip_headsigns", {})

    raw = _merge_rt_static(rt_deps, static_deps)

    upcoming = sorted(
        [d for d in raw if d["time"] >= now - 60],
        key=lambda d: d["time"],
    )[:limit]

    deps = []
    for d in upcoming:
        route_id = d["route_id"]
        trip_id = d["trip_id"]
        if not route_id:
            route_id = trips.get(trip_id, {}).get("route_id", "")
        route = routes.get(route_id, {})
        headsign = trip_headsigns.get(trip_id, "") or route.get("route_long_name", "")
        deps.append({
            "route_short_name": route.get("route_short_name", "?"),
            "route_color": route.get("route_color", "0074D9"),
            "route_text_color": route.get("route_text_color", "FFFFFF"),
            "headsign": headsign,
            "departure_time": d["time"],
            "is_realtime": d["is_realtime"],
        })

    result = {"stop_id": stop_id, "departures": deps, "count": len(deps)}
    _cache_set(cache_key, result)
    return jsonify(result)


@app.route("/api/stops/stations")
def stations():
    """Return only parent stations (location_type=1)."""
    with _lock:
        stop_list = list(_data["stops"].values())
    result = [s for s in stop_list if s["location_type"] == 1]
    return jsonify({"stops": result, "count": len(result)})


@app.route("/api/shapes/trains")
def train_shapes():
    """Return deduplicated rail geometries (one entry per shape_id, not per route)."""
    with _lock:
        trips    = _data["trips"]
        routes   = _data["routes"]
        all_shapes = _data["shapes"]

    train_route_ids = {rid for rid, r in routes.items()
                       if r["route_type"] == 2 or 100 <= r["route_type"] <= 199}
    shape_ids = {t["shape_id"] for t in trips.values()
                 if t.get("route_id") in train_route_ids and t.get("shape_id")}
    shapes_out = {sid: all_shapes[sid] for sid in shape_ids if sid in all_shapes}
    return jsonify({"shapes": shapes_out, "count": len(shapes_out)})


@app.route("/api/shapes")
def shapes():
    """Return all shapes (route geometries)."""
    with _lock:
        all_shapes = _data["shapes"]
    return jsonify({"shapes": all_shapes, "count": len(all_shapes)})


@app.route("/api/shapes/bulk")
def shapes_bulk():
    """Return shapes for multiple routes in one request (avoids burst of parallel HTTP calls)."""
    route_ids_param = request.args.get("route_ids", "")[:2000]
    if not route_ids_param:
        return jsonify({"routes": {}, "count": 0})

    requested = {r.strip() for r in route_ids_param.split(",") if r.strip()}

    with _lock:
        trips = _data["trips"]
        all_shapes = _data["shapes"]

    # Build route_id → shape coords list in one pass over trips
    route_shape_ids: dict[str, set] = {}
    for trip in trips.values():
        rid = trip["route_id"]
        sid = trip.get("shape_id", "")
        if rid in requested and sid:
            route_shape_ids.setdefault(rid, set()).add(sid)

    result = {}
    for route_id in requested:
        coords_list = [all_shapes[sid] for sid in route_shape_ids.get(route_id, set()) if sid in all_shapes]
        if coords_list:
            result[route_id] = coords_list

    return jsonify({"routes": result, "count": len(result)})


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


@app.route("/api/debug/stops-fields")
def debug_stops_fields():
    """Debug: show coverage of platform_code / stop_desc / parent_station in GTFS stops.

    ?local=1  restricts sample to stops within Örebro county bounding box.
    """
    with _lock:
        stops = list(_data["stops"].values())

    # Örebro county bounding box (approx)
    LAT_MIN, LAT_MAX = 58.7, 59.9
    LON_MIN, LON_MAX = 14.2, 15.8

    local_only = request.args.get("local", "1") not in ("0", "false")
    if local_only:
        local_stops = [
            s for s in stops
            if LAT_MIN <= s.get("stop_lat", 0) <= LAT_MAX
            and LON_MIN <= s.get("stop_lon", 0) <= LON_MAX
        ]
    else:
        local_stops = stops

    total = len(stops)
    local_total = len(local_stops)

    has_platform = [s for s in local_stops if s.get("platform_code")]
    has_desc = [s for s in local_stops if s.get("stop_desc")]
    has_parent = [s for s in local_stops if s.get("parent_station")]

    # Unique platform_code values present
    platform_values = sorted(set(s["platform_code"] for s in has_platform))

    # Sample up to 20 stops that have platform_code
    sample = sorted(has_platform, key=lambda s: s["stop_id"])[:20]

    return jsonify({
        "note": "Filtered to Örebro county (local=1). Pass ?local=0 to see all Sweden.",
        "total_stops_in_feed": total,
        "local_stops": local_total,
        "with_platform_code": len(has_platform),
        "with_stop_desc": len(has_desc),
        "with_parent_station": len(has_parent),
        "platform_code_values": platform_values,
        "platform_code_sample": [
            {
                "stop_id": s["stop_id"],
                "stop_name": s.get("stop_name", ""),
                "platform_code": s.get("platform_code", ""),
                "stop_desc": s.get("stop_desc", ""),
                "parent_station": s.get("parent_station", ""),
                "location_type": s.get("location_type", 0),
                "lat": s.get("stop_lat"),
                "lon": s.get("stop_lon"),
            }
            for s in sample
        ],
    })


@app.route("/api/debug/routes")
@_debug_only
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
@_debug_only
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


@app.route("/api/debug/trains")
@_debug_only
def debug_trains():
    """Show current Oxyfi train state."""
    trains = oxyfi.get_trains()
    return jsonify({
        "oxyfi_key_set": bool(config.OXYFI_API_KEY),
        "train_count": len(trains),
        "last_update": oxyfi._last_update,
        "trains": trains,
    })


@app.route("/api/stats/visit", methods=["POST"])
def stats_visit():
    data = request.get_json(silent=True) or {}
    session_id = str(data.get("session_id", ""))[:64]
    page = str(data.get("page", "/"))[:200]
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()
    if session_id:
        _stats.record_visit(session_id, page, ip)
    return "", 204


@app.route("/api/stats/leave", methods=["POST"])
def stats_leave():
    data = request.get_json(silent=True, force=True) or {}
    session_id = str(data.get("session_id", ""))[:64]
    try:
        duration = int(data.get("duration", 0))
    except (TypeError, ValueError):
        duration = 0
    if session_id:
        _stats.record_leave(session_id, duration)
    return "", 204


@app.route("/api/stats")
def stats_view():
    return jsonify(_stats.get_stats())


@app.route("/api/alerts")
def alerts():
    """Return current service alerts."""
    with _lock:
        alert_list = _data["alerts"]
    return jsonify({"alerts": alert_list, "count": len(alert_list)})


@app.route("/api/stream")
def sse_stream():
    """Server-Sent Events stream: pushes vehicle and alert updates in real time."""
    client_ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip() or "unknown"

    with _sse_ip_lock:
        if _sse_ip_counts.get(client_ip, 0) >= _MAX_SSE_PER_IP:
            return jsonify({"error": "Too many SSE connections from this IP"}), 429
        _sse_ip_counts[client_ip] = _sse_ip_counts.get(client_ip, 0) + 1

    def generate():
        q = _queue.Queue(maxsize=20)
        with _sse_clients_lock:
            _sse_clients.append(q)
        try:
            # Send current state immediately on connect
            with _lock:
                vehicle_list = list(_data["vehicles"])
                alerts_list = list(_data["alerts"])
                ts = _data["last_vehicle_update"]
            enriched = _enrich_vehicles(vehicle_list)
            yield (f"event: vehicles\ndata: "
                   f"{json.dumps({'vehicles': enriched, 'timestamp': ts, 'count': len(enriched)}, separators=(',', ':'))}"
                   f"\n\n")
            if alerts_list:
                yield (f"event: alerts\ndata: "
                       f"{json.dumps({'alerts': alerts_list, 'count': len(alerts_list)}, separators=(',', ':'))}"
                       f"\n\n")
            while True:
                try:
                    msg = q.get(timeout=25)
                    yield msg
                except _queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            with _sse_clients_lock:
                try:
                    _sse_clients.remove(q)
                except ValueError:
                    pass
            with _sse_ip_lock:
                remaining = _sse_ip_counts.get(client_ip, 1) - 1
                if remaining <= 0:
                    _sse_ip_counts.pop(client_ip, None)
                else:
                    _sse_ip_counts[client_ip] = remaining

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


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

    # Find ALL trips for this route+direction, then pick the one with the most stops
    # so that short-turn variants don't cause stops to disappear from the sequence.
    candidate_trips = [
        tid for tid, t in trips.items()
        if t.get("route_id") == route_id
        and str(t.get("direction_id", "0") or "0") == direction_id
    ]
    if not candidate_trips:
        return []

    trip_data = gtfs_loader.load_stop_times_for_trips(set(candidate_trips))
    if not trip_data:
        return []

    # Use the trip that covers the most stops as the canonical sequence
    rep_trip = max(trip_data, key=lambda tid: len(trip_data[tid]))

    seq = [
        {
            "stop_id": s["stop_id"],
            "stop_name": stops.get(s["stop_id"], {}).get("stop_name", s["stop_id"]),
            "departure_time": s.get("departure_time", "") or s.get("arrival_time", ""),
        }
        for s in trip_data[rep_trip]
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
            # Static direction_id is authoritative when available (RT feed often leaves it 0).
            # Fall back to RT direction_id only when no static match exists.
            if static:
                dir_id = str(static.get("direction_id", "0") or "0")
            else:
                dir_id = str(dep.get("direction_id") or "0")
            if tid not in trip_rt:
                trip_rt[tid] = {"dir": dir_id, "stop_times": {}}
            existing = trip_rt[tid]["stop_times"].get(stop_id)
            if existing is None or t < existing[0]:
                trip_rt[tid]["stop_times"][stop_id] = (t, dep.get("is_realtime", False))

    # Per direction: collect ALL active trips, sorted by progress (furthest along first).
    # A trip with many already-departed stops is the one currently in service.
    dir_trips = {}  # dir_id -> [(past_count, min_future, tid)]
    for tid, td in trip_rt.items():
        future = [t for t, _ in td["stop_times"].values() if t >= now]
        if not future:
            continue
        past_count = sum(1 for t, _ in td["stop_times"].values() if t < now)
        dir_id = td["dir"]
        dir_trips.setdefault(dir_id, []).append((-past_count, min(future), tid))

    directions_out = []
    for dir_id in sorted(dir_trips.keys()):
        all_tids = [tid for _, _, tid in dir_trips[dir_id]]

        # Merge all trips: for each stop keep the earliest upcoming departure
        # across all active buses in this direction → complete merged timetable.
        merged = {}  # stop_id -> (unix_t, is_rt)
        headsign = ""
        for tid in all_tids:
            if not headsign:
                headsign = trip_headsigns.get(tid, "")
            for sid, (t, is_rt) in trip_rt[tid]["stop_times"].items():
                if t < now:
                    continue
                if sid not in merged or t < merged[sid][0]:
                    merged[sid] = (t, is_rt)

        if not merged:
            continue

        # Build static stop sequence for canonical ordering and stop names
        seq = _get_stop_sequence(route_id, dir_id)
        if seq:
            stops_out = []
            for ss in seq:
                sid = ss["stop_id"]
                if sid not in merged:
                    continue
                t, is_rt = merged[sid]
                stops_out.append({
                    "stop_id": sid,
                    "stop_name": ss["stop_name"],
                    "time": t,
                    "minutes": max(0, round((t - now) / 60)),
                    "is_realtime": is_rt,
                })
        else:
            stops_out = [
                {
                    "stop_id": sid,
                    "stop_name": stops.get(sid, {}).get("stop_name", sid),
                    "time": t,
                    "minutes": max(0, round((t - now) / 60)),
                    "is_realtime": is_rt,
                }
                for sid, (t, is_rt) in sorted(merged.items(), key=lambda x: x[1][0])
            ]

        if stops_out:
            directions_out.append({
                "direction_id": dir_id,
                "headsign": headsign,
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
    """Return the soonest upcoming departure per stop (used for map badges).

    Uses GTFS static timetable as base so all stops with scheduled service
    get a badge, then overrides with real-time data where available.
    """
    cached = _cache_get("next_dep")
    if cached:
        return jsonify(cached)

    with _lock:
        rt_departures = dict(_data.get("stop_departures", {}))
        static_departures = dict(_data.get("static_stop_departures", {}))
        routes = _data["routes"]
        trips = _data["trips"]
        trip_headsigns = _data.get("trip_headsigns", {})
        now = int(time.time())
    horizon = now + 3 * 3600

    # Merge: RT overrides static per trip_id, but keeps static for trips without RT
    merged = {}
    all_stops = set(static_departures) | set(rt_departures)
    for stop_id in all_stops:
        rt_deps = rt_departures.get(stop_id, [])
        merged[stop_id] = _merge_rt_static(rt_deps, static_departures.get(stop_id, []))

    def _best_dep(deps):
        best = None
        for dep in deps:
            t = dep.get("time", 0)
            if t < now or t > horizon:
                continue
            if best is None or t < best["time"]:
                trip_id = dep.get("trip_id", "")
                dep_route_id = dep.get("route_id", "")
                ri = routes.get(dep_route_id, {})
                if not ri:
                    static_route_id = trips.get(trip_id, {}).get("route_id", "")
                    ri = routes.get(static_route_id, {})
                headsign = trip_headsigns.get(trip_id, "")
                best = {
                    "time": t,
                    "minutes": max(0, round((t - now) / 60)),
                    "route_short_name": ri.get("route_short_name", ""),
                    "route_color": ri.get("route_color", "0074D9"),
                    "route_text_color": ri.get("route_text_color", "FFFFFF"),
                    "headsign": headsign,
                }
        return best

    result = {}
    for stop_id, deps in merged.items():
        best = _best_dep(deps)
        if best:
            result[stop_id] = best

    _cache_set("next_dep", result)
    return jsonify(result)


# --- Startup ---

def _push_train_positions():
    """Push merged bus+train positions via SSE (runs every 5 s if trains are active)."""
    trains = oxyfi.get_trains()
    if not trains:
        return
    with _lock:
        vehicle_list = list(_data["vehicles"])
        ts = _data["last_vehicle_update"]
    buses = _enrich_vehicles(vehicle_list)  # takes _lock internally — must be outside our lock
    combined = buses + trains
    _push_sse("vehicles", {"vehicles": combined, "timestamp": ts, "count": len(combined)})


def start_background_tasks():
    """Initialize GTFS data and start polling."""
    threading.Thread(target=init_gtfs_static, daemon=True).start()

    scheduler = BackgroundScheduler()
    scheduler.add_job(poll_realtime, "interval", seconds=config.RT_POLL_SECONDS,
                      max_instances=1)
    scheduler.add_job(refresh_gtfs_static, "interval",
                      hours=config.GTFS_REFRESH_HOURS, max_instances=1)
    # Refresh static departures daily at midnight (new timetable day)
    scheduler.add_job(_refresh_static_departures, "cron", hour=0, minute=1, max_instances=1)
    # Retry GTFS static loading every 60s if it failed
    scheduler.add_job(_retry_gtfs_if_needed, "interval", seconds=60, max_instances=1)
    # Push live train positions via SSE every 5 seconds (Oxyfi updates ~1/s per train)
    scheduler.add_job(_push_train_positions, "interval", seconds=5, max_instances=1)
    scheduler.start()

    threading.Thread(target=poll_realtime, daemon=True).start()
    oxyfi.start()


def _retry_gtfs_if_needed():
    """Retry loading GTFS static with exponential backoff, max 5 attempts."""
    global _gtfs_retry_count, _gtfs_next_retry_at
    with _lock:
        if _data["gtfs_loaded"] and _data["routes"]:
            return  # Already loaded successfully

    MAX_RETRIES = 5
    if _gtfs_retry_count >= MAX_RETRIES:
        return  # Give up until the next scheduled 48-hour refresh

    now = time.time()
    if now < _gtfs_next_retry_at:
        return  # Not time yet

    _gtfs_retry_count += 1
    delay = min(60 * (2 ** (_gtfs_retry_count - 1)), 3600)  # 60s, 120s, 240s, 480s, 960s
    _gtfs_next_retry_at = now + delay
    print(f"GTFS static not loaded, retry {_gtfs_retry_count}/{MAX_RETRIES} "
          f"(next attempt in {delay}s if this fails)...")
    init_gtfs_static()
    with _lock:
        if _data["gtfs_loaded"]:
            _gtfs_retry_count = 0  # reset on success


start_background_tasks()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
