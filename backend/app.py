"""Flask backend for LTlive - Live bus tracking for Örebro."""

import json
import math
import os
import queue as _queue
import threading
import time
import traceback

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
import trafikverket as tv_api

# Shared state, cache and debug decorator (used by app.py and Blueprint modules)
from store import (
    _data, _lock, _api_cache,
    _cache_get, _cache_set, _invalidate_cache,
    _debug_only,
)
# Departure merge utility (also used by stops Blueprint)
from trip_utils import merge_rt_static as _merge_rt_static
# Train processing logic (isolated from bus pipeline)
from train_logic import (
    _tv_trains_from_positions,
    _annotate_oxyfi_from_announcements,
    _merge_trains,
)
# Vehicle enrichment shared with vehicles_bp and SSE stream
from enrichment import enrich_vehicles as _enrich_vehicles

app = Flask(__name__)

# Restrict CORS to explicitly configured origins (default: none — all traffic is same-origin in prod).
# Set ALLOWED_ORIGINS=https://yourdomain.com for dev/multi-origin setups.
_allowed_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
CORS(app, resources={r"/api/*": {"origins": _allowed_origins or [], "methods": ["GET", "POST"]}})

# Register Blueprints
from api.debug_bp import bp as _debug_bp
from api.routes_shapes_bp import bp as _routes_shapes_bp
from api.stops_bp import bp as _stops_bp
from api.vehicles_bp import bp as _vehicles_bp
app.register_blueprint(_debug_bp)
app.register_blueprint(_routes_shapes_bp)
app.register_blueprint(_stops_bp)
app.register_blueprint(_vehicles_bp)

_stats.init_db()

# Stop-sequence cache — used only by line_departures endpoint in this file
_stop_seq_cache = {}   # (route_id, dir_id) -> [{"stop_id", "stop_name"}, ...]
_stop_seq_lock = threading.Lock()

_gtfs_retry_count = 0
_gtfs_next_retry_at = 0  # epoch seconds; 0 = retry immediately

# SSE client registry: each connected client has a Queue
_sse_clients = []
_sse_clients_lock = threading.Lock()

# Per-IP SSE connection counter (DoS protection)
_sse_ip_counts: dict[str, int] = {}
_sse_ip_lock = threading.Lock()
_MAX_SSE_PER_IP = 4


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

        agencies = gtfs_loader.load_agencies()
        routes = gtfs_loader.load_routes()
        stops = gtfs_loader.load_stops()
        trips = gtfs_loader.load_trips()
        shapes = gtfs_loader.load_shapes()

        if not routes:
            print("GTFS routes empty after load, forcing re-download...")
            _clean_gtfs_dir()
            gtfs_loader.download_gtfs_static()
            agencies = gtfs_loader.load_agencies()
            routes = gtfs_loader.load_routes()
            stops = gtfs_loader.load_stops()
            trips = gtfs_loader.load_trips()
            shapes = gtfs_loader.load_shapes()

        # Build headsigns, stop->route map and today's static departures/arrivals in one pass
        print("Building trip headsigns, stop->route map and static departures from stop_times...")
        trip_headsigns, stop_route_map, static_stop_departures, static_stop_arrivals, trip_origin_map = (
            gtfs_loader.load_trip_headsigns_and_stop_route_map(stops, trips)
        )

        with _lock:
            _data["agencies"] = agencies
            _data["routes"] = routes
            _data["stops"] = stops
            _data["trips"] = trips
            _data["shapes"] = shapes
            _data["trip_headsigns"] = trip_headsigns
            _data["trip_origin_map"] = trip_origin_map
            _data["stop_route_map"] = stop_route_map
            _data["static_stop_departures"] = static_stop_departures
            _data["static_stop_arrivals"] = static_stop_arrivals
            _data["gtfs_loaded"] = True
            _data["gtfs_error"] = None

        active_services = gtfs_loader.active_service_ids_today()
        active_trip_count = sum(
            1 for t in trips.values()
            if t.get("service_id", "") in active_services
        )
        print(f"GTFS loaded: {len(routes)} routes, {len(stops)} stops, "
              f"{len(trips)} trips ({active_trip_count} active today), {len(shapes)} shapes, "
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
        _, _, static_stop_departures, static_stop_arrivals, trip_origin_map = (
            gtfs_loader.load_trip_headsigns_and_stop_route_map(stops, trips)
        )
        with _lock:
            _data["static_stop_departures"] = static_stop_departures
            _data["static_stop_arrivals"] = static_stop_arrivals
            _data["trip_origin_map"] = trip_origin_map
        print(f"Static departures refreshed: {len(static_stop_departures)} stops with service today")
    except Exception as e:
        print(f"Error refreshing static departures: {e}")

def refresh_gtfs_static():
    """Re-download GTFS static data (scheduled every GTFS_REFRESH_HOURS)."""
    try:
        _clean_gtfs_dir()
        gtfs_loader.download_gtfs_static()
        agencies = gtfs_loader.load_agencies()
        routes = gtfs_loader.load_routes()
        stops = gtfs_loader.load_stops()
        trips = gtfs_loader.load_trips()
        shapes = gtfs_loader.load_shapes()
        trip_headsigns, _, static_stop_departures, static_stop_arrivals, trip_origin_map = (
            gtfs_loader.load_trip_headsigns_and_stop_route_map(stops, trips)
        )

        with _lock:
            _data["agencies"] = agencies
            _data["routes"] = routes
            _data["stops"] = stops
            _data["trips"] = trips
            _data["shapes"] = shapes
            _data["trip_headsigns"] = trip_headsigns
            _data["static_stop_departures"] = static_stop_departures
            _data["static_stop_arrivals"] = static_stop_arrivals
            _data["trip_origin_map"] = trip_origin_map
            _data["gtfs_error"] = None
        # Invalidate all API caches — routes, shapes, stops, departures all changed.
        _invalidate_cache()
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
    vehicle_trips, vehicle_next_stop, stop_departures, rt_trip_short_names = gtfs_rt.fetch_trip_updates()
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
        if rt_trip_short_names:
            _data["rt_trip_short_names"] = rt_trip_short_names
        if alerts:
            _data["alerts"] = alerts
        _data["last_vehicle_update"] = int(time.time())

    # Selectively invalidate: bus poll changes vehicles + departures, not shapes/routes.
    _api_cache.invalidate("vehicles")
    _api_cache.invalidate("next_dep")
    _api_cache.invalidate_prefix("dep")

    # Vehicles SSE is handled by _push_train_positions (runs every 5 s)
    # which merges buses + trains in one push, avoiding double events.
    if alerts:
        _push_sse("alerts", {"alerts": alerts, "count": len(alerts)})

# --- API Routes ---

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "gtfs_loaded": _data["gtfs_loaded"]})

@app.route("/api/status")
def status():
    """Public status — only the fields the frontend needs. No internal details."""
    with _lock:
        gtfs_error = _data["gtfs_error"]
        routes_count = len(_data["routes"])
        gtfs_loaded = _data["gtfs_loaded"]
    return jsonify({
        "gtfs_loaded": gtfs_loaded,
        # Expose a boolean flag only — never the raw error string (may contain paths/keys)
        "gtfs_error": bool(gtfs_error),
        "routes_count": routes_count,
        "nearby_radius_meters": config.NEARBY_RADIUS_METERS,
        "frontend_poll_interval_ms": config.FRONTEND_POLL_INTERVAL_MS,
        "map_center_lat": config.MAP_CENTER_LAT,
        "map_center_lon": config.MAP_CENTER_LON,
        "map_default_zoom": config.MAP_DEFAULT_ZOOM,
    })


@app.route("/api/departures/<stop_id>")
def departures_for_stop(stop_id):
    """Return upcoming departures for a stop, enriched with route info.

    If stop_id is a parent station (location_type=1) the departures of all
    child stops are merged automatically.

    Optional query params:
        limit: max rows (1-30, default 10)
        route_type: 'train' to filter to rail routes only
    """
    limit = max(1, min(int(request.args.get("limit", 10)), 30))
    only_trains = request.args.get("route_type") == "train"
    cache_key = ("dep", stop_id, limit, only_trains)
    cached = _cache_get(cache_key)
    if cached:
        return jsonify(cached)

    now = int(time.time())
    with _lock:
        all_stops_data = _data["stops"]
        # Collect all stop_ids to query: if this is a parent station, expand
        # to all child stops so we get departures from every platform.
        target_stop = all_stops_data.get(stop_id, {})
        if target_stop.get("location_type", 0) == 1:
            child_ids = [
                s["stop_id"] for s in all_stops_data.values()
                if s.get("parent_station") == stop_id
            ]
            query_ids = child_ids if child_ids else [stop_id]
        else:
            query_ids = [stop_id]

        rt_deps = []
        static_deps = []
        # Tag each dep with its source stop_id so we can look up platform_code
        for qid in query_ids:
            platform_code = all_stops_data.get(qid, {}).get("platform_code", "")
            for dep in _data.get("stop_departures", {}).get(qid, []):
                rt_deps.append({**dep, "_platform": platform_code})
            for dep in _data.get("static_stop_departures", {}).get(qid, []):
                static_deps.append({**dep, "_platform": platform_code})
        routes = _data["routes"]
        trips = _data["trips"]
        trip_headsigns = _data.get("trip_headsigns", {})
        rt_trip_short_names = _data.get("rt_trip_short_names", {})
        tv_ann = _data.get("tv_announcements", {})
        tv_stations = _data.get("tv_stations", {})

    raw = _merge_rt_static(rt_deps, static_deps)

    upcoming = sorted(
        [d for d in raw if d["time"] >= now - 600],
        key=lambda d: d["time"],
    )

    tib_agency = config.TIB_AGENCY_ID
    tib_routes = config.TIB_ROUTE_SHORT_NAMES
    # Resolve Trafikverket location signature once, outside the loop
    loc_sig = config.TRAFIKVERKET_STATIONS.get(stop_id, "")
    if not loc_sig:
        for qid in query_ids:
            ls = config.TRAFIKVERKET_STATIONS.get(qid, "")
            if ls:
                loc_sig = ls
                break
    deps = []
    used_tv_dep_keys = set()  # prevent two GTFS trips matching the same TV announcement
    for d in upcoming:
        route_id = d["route_id"]
        trip_id = d["trip_id"]
        if not route_id:
            route_id = trips.get(trip_id, {}).get("route_id", "")
        route = routes.get(route_id, {})
        if only_trains:
            rt = route.get("route_type", 3)
            if not (rt == 2 or 100 <= rt <= 199):
                continue
            # Agency/routes filter applies only inside the train-only view.
            # When showing a bus stop popup (only_trains=False) we skip filtering
            # so that all operators serving that stop are shown.
            if tib_routes:
                if route.get("route_short_name", "") not in tib_routes:
                    continue
            elif tib_agency and route.get("agency_id", "") != tib_agency:
                continue
        headsign = trip_headsigns.get(trip_id, "") or route.get("route_long_name", "")
        trip_short_name = (
            trips.get(trip_id, {}).get("trip_short_name", "")
            or rt_trip_short_names.get(trip_id, "")
            or d.get("rt_trip_short_name", "")
        )
        rsn = route.get("route_short_name", "?")
        color = config.ROUTE_COLOR_OVERRIDES.get(rsn) or route.get("route_color", "0074D9")

        # Enrich from Trafikverket TrainAnnouncement if stop is mapped
        tv_track = ""
        tv_canceled = False
        tv_deviation = []
        tv_via = []
        tv_other_info = []
        tv_preliminary = False
        tv_traffic_type = ""
        tv_rt_time = None
        tv_sched_override = None
        tv_track_changed = False
        tv_operator = ""
        tv_product = ""
        best_tv = None
        if loc_sig and tv_ann.get(loc_sig):
            # Use static scheduled time for matching when available (RT time may be delayed)
            dep_time = d.get("sched_time") or d["time"]
            tv_ops = config.TRAFIKVERKET_OPERATORS
            best_tv = None
            best_diff = float("inf")
            # First pass: preferred operators only (avoids cross-operator time collisions)
            if tv_ops:
                for tv_dep in tv_ann[loc_sig].get("departures", []):
                    if tv_dep.get("operator", "") not in tv_ops:
                        continue
                    tv_key = (tv_dep["train_number"], tv_dep["scheduled_time"])
                    if tv_key in used_tv_dep_keys:
                        continue
                    diff = abs(tv_dep["scheduled_time"] - dep_time)
                    if diff < best_diff and diff <= 600:
                        best_diff = diff
                        best_tv = tv_dep
            # Second pass: any operator.
            # Window: tight 3-min when preferred operators are configured (reduces
            # cross-operator mismatches); generous 10-min when no operator filter is
            # set (single-operator setup where all TV trains belong to us).
            fallback_window = 180 if tv_ops else 600
            if best_tv is None:
                best_diff = float("inf")
                for tv_dep in tv_ann[loc_sig].get("departures", []):
                    tv_key = (tv_dep["train_number"], tv_dep["scheduled_time"])
                    if tv_key in used_tv_dep_keys:
                        continue
                    diff = abs(tv_dep["scheduled_time"] - dep_time)
                    if diff < best_diff and diff <= fallback_window:
                        best_diff = diff
                        best_tv = tv_dep
            if best_tv:
                used_tv_dep_keys.add((best_tv["train_number"], best_tv["scheduled_time"]))
                # TV AdvertisedTrainIdent is always authoritative — overrides GTFS
                # trip_short_name which is often set to the route/line name (e.g. "T53")
                trip_short_name = best_tv["train_number"]
                tv_operator = best_tv.get("operator", "")
                tv_product = best_tv.get("product", "")
                # Update color based on operator if no explicit override configured
                if not config.ROUTE_COLOR_OVERRIDES.get(rsn):
                    op_l = tv_operator.lower()
                    pr_l = tv_product.lower()
                    if "mälartåg" in op_l or "mälartåg" in pr_l:
                        color = "005B99"
                    elif "sj" in op_l:
                        color = "D4004C"
                    elif "arriva" in op_l or "bergslagen" in pr_l:
                        color = "E87722"
                tv_track = best_tv["track"]
                tv_canceled = best_tv["canceled"]
                tv_deviation = best_tv["deviation"]
                tv_other_info = best_tv.get("other_info", [])
                tv_preliminary = best_tv.get("preliminary", False)
                tv_traffic_type = best_tv.get("traffic_type", "")
                tv_rt_time = best_tv.get("realtime_time")
                tv_sched_override = best_tv["scheduled_time"]
                tv_track_changed = any("spår" in t.lower() for t in tv_deviation)
                # Always use TV destination and via — TV is authoritative, GTFS may be stale
                if best_tv["dest_sig"]:
                    headsign = tv_stations.get(best_tv["dest_sig"], {}).get("name", best_tv["dest_sig"])
                tv_via = []
                for vsig in best_tv.get("via_sigs", [])[:3]:
                    vname = tv_stations.get(vsig, {}).get("name", vsig)
                    tv_via.append(vname)

        # If TV confirms actual departure (TimeAtLocation set) and it was >60s ago, skip
        if best_tv and best_tv.get("has_actual_time") and tv_rt_time and tv_rt_time < now - 60:
            continue

        platform = tv_track or d.get("_platform", "")
        # Use TV scheduled time as base when matched (more accurate than GTFS).
        # For unmatched GTFS-RT entries, prefer the static scheduled time so
        # that departure_time (realtime) and scheduled_time can actually differ.
        sched_time = tv_sched_override if tv_sched_override else (d.get("sched_time") or d["time"])
        # When TV is matched, only use TV realtime (don't fall back to GTFS-RT —
        # that would show a delay TV doesn't know about)
        rt_time = tv_rt_time if tv_sched_override else (d["time"] if d["is_realtime"] else None)
        actual_dep = rt_time if rt_time else sched_time
        deps.append({
            "route_short_name": rsn,
            "trip_short_name": trip_short_name,
            "route_color": color,
            "route_text_color": route.get("route_text_color", "FFFFFF"),
            "operator": tv_operator,
            "product": tv_product,
            "headsign": headsign,
            "departure_time": actual_dep,
            "scheduled_time": sched_time,
            "delay_minutes": round((actual_dep - sched_time) / 60) if rt_time else 0,
            "is_realtime": bool(rt_time),
            "trip_id": trip_id,
            "platform": platform,
            "track_changed": tv_track_changed,
            "canceled": tv_canceled,
            "deviation": tv_deviation,
            "other_info": tv_other_info,
            "preliminary": tv_preliminary,
            "traffic_type": tv_traffic_type,
            "via": tv_via,
        })
        if len(deps) >= limit:
            break

    # TV-only trains: operators not in GTFS (e.g. Mälartåg, SJ).
    # Only added when explicitly requesting trains (?route_type=train).
    if only_trains and loc_sig and tv_ann.get(loc_sig):
        for tv_dep in tv_ann[loc_sig].get("departures", []):
            tv_key = (tv_dep["train_number"], tv_dep["scheduled_time"])
            if tv_key in used_tv_dep_keys:
                continue  # already matched to a GTFS entry
            if tv_dep["scheduled_time"] < now - 60:
                continue  # skip past departures
            if tv_dep.get("has_actual_time") and tv_dep.get("realtime_time") and tv_dep["realtime_time"] < now - 60:
                continue  # TV confirms actual departure has happened >60s ago
            op = (tv_dep.get("operator") or "").lower()
            pr = (tv_dep.get("product") or "").lower()
            if "mälartåg" in op or "mälartåg" in pr:
                tv_color, tv_rsn = "005B99", "MÅ"
            elif "sj" in op:
                tv_color, tv_rsn = "D4004C", "SJ"
            elif "arriva" in op or "bergslagen" in pr:
                tv_color, tv_rsn = "E87722", "TiB"
            elif "snälltåget" in op:
                tv_color, tv_rsn = "1A1A1A", "SNÅ"
            else:
                tv_color, tv_rsn = "555555", "?"
            dest_name = tv_stations.get(tv_dep.get("dest_sig", ""), {}).get("name", "") if tv_dep.get("dest_sig") else ""
            via_names = [tv_stations.get(v, {}).get("name", v) for v in tv_dep.get("via_sigs", [])[:3]]
            sched_t = tv_dep["scheduled_time"]
            rt_t = tv_dep.get("realtime_time")
            track_chg = any("spår" in t.lower() for t in tv_dep.get("deviation", []))
            tv_actual_dep = rt_t if rt_t else sched_t
            deps.append({
                "route_short_name": tv_rsn,
                "trip_short_name": tv_dep["train_number"],
                "route_color": tv_color,
                "route_text_color": "FFFFFF",
                "operator": tv_dep.get("operator", ""),
                "product": tv_dep.get("product", ""),
                "headsign": dest_name,
                "departure_time": tv_actual_dep,
                "scheduled_time": sched_t,
                "delay_minutes": round((tv_actual_dep - sched_t) / 60) if rt_t else 0,
                "is_realtime": bool(rt_t),
                "trip_id": "",
                "platform": tv_dep.get("track", ""),
                "track_changed": track_chg,
                "canceled": tv_dep.get("canceled", False),
                "deviation": tv_dep.get("deviation", []),
                "other_info": tv_dep.get("other_info", []),
                "preliminary": tv_dep.get("preliminary", False),
                "traffic_type": tv_dep.get("traffic_type", ""),
                "via": via_names,
            })
        # Re-sort after adding TV-only entries (they may not be in time order)
        deps.sort(key=lambda x: x["departure_time"])

    # Deduplicate: same scheduled time + same headsign = same physical train
    # (happens when a GTFS trip split/join creates two entries for one train)
    seen_dep_keys = set()
    deduped_deps = []
    for entry in deps:
        key = (entry["scheduled_time"], entry["headsign"])
        if key not in seen_dep_keys:
            seen_dep_keys.add(key)
            deduped_deps.append(entry)
    deps = deduped_deps[:limit]

    result = {"stop_id": stop_id, "departures": deps, "count": len(deps)}
    _cache_set(cache_key, result)
    return jsonify(result)

@app.route("/api/arrivals/<stop_id>")
def arrivals_for_stop(stop_id):
    """Return upcoming train arrivals for a stop, enriched with origin info.

    If stop_id is a parent station (location_type=1) arrivals from all child
    stops are merged automatically.

    Optional query params:
        limit: max rows (1-30, default 10)
        route_type: 'train' to filter to rail routes only (default all)
    """
    limit = max(1, min(int(request.args.get("limit", 10)), 30))
    only_trains = request.args.get("route_type") == "train"

    now = int(time.time())
    with _lock:
        all_stops_data = _data["stops"]
        target_stop = all_stops_data.get(stop_id, {})
        if target_stop.get("location_type", 0) == 1:
            child_ids = [
                s["stop_id"] for s in all_stops_data.values()
                if s.get("parent_station") == stop_id
            ]
            query_ids = child_ids if child_ids else [stop_id]
        else:
            query_ids = [stop_id]

        static_arrs = []
        for qid in query_ids:
            static_arrs.extend(_data.get("static_stop_arrivals", {}).get(qid, []))
        routes = _data["routes"]
        trips = _data["trips"]
        trip_headsigns = _data.get("trip_headsigns", {})
        trip_origin_map = _data.get("trip_origin_map", {})
        rt_trip_short_names = _data.get("rt_trip_short_names", {})
        tv_ann = _data.get("tv_announcements", {})
        tv_stations = _data.get("tv_stations", {})
        tv_positions_raw = list(_data.get("tv_positions", []))
        # Names of the destination station — used to filter out arrivals that
        # originate from this very station (GTFS trips that start here).
        dest_stop_names = {
            all_stops_data.get(qid, {}).get("stop_name", "") for qid in query_ids
        }
        dest_stop_names.add(target_stop.get("stop_name", ""))
        dest_stop_names.discard("")

    # Build GPS position lookup by train number (newest position per train, max 10 min old).
    # Prefer Öxyfin data for TiB trains (≤30 s old), fall back to Trafikverket TrainPosition.
    # 600 s matches the cutoff used in _tv_trains_from_positions() for consistency.
    _pos_cutoff = now - 600
    pos_by_train: dict[str, dict] = {}
    for _p in tv_positions_raw:
        _tn = _p.get("train_number", "")
        if not _tn:
            continue
        _ts = _p.get("timestamp") or 0
        if _ts < _pos_cutoff:
            continue
        if _tn not in pos_by_train or _ts > (pos_by_train[_tn].get("timestamp") or 0):
            pos_by_train[_tn] = _p
    # Öxyfin positions are ≤30 s old and most accurate for TiB — overwrite/add
    for _p in oxyfi.get_trains():
        _tn = _p.get("label", "")
        if _tn:
            pos_by_train[_tn] = _p

    _sta_lat = config.TV_POSITION_CENTER_LAT
    _sta_lon = config.TV_POSITION_CENTER_LON
    _cos_lat = math.cos(math.radians(_sta_lat))
    _GPS_ARRIVED_M = 600  # metres — train must be within this radius to show "Ankommit"

    def _gps_at_station(train_num: str) -> bool | None:
        """Return True/False if GPS confirms train is at/away from station, None if no data."""
        pos = pos_by_train.get(train_num)
        if not pos:
            return None
        dlat = math.radians(pos["lat"] - _sta_lat)
        dlon = math.radians(pos["lon"] - _sta_lon)
        dist_m = 6371000 * math.sqrt(dlat ** 2 + (_cos_lat * dlon) ** 2)
        return dist_m <= _GPS_ARRIVED_M

    upcoming_raw = sorted(
        [a for a in static_arrs if a["time"] >= now - 600],
        key=lambda a: a["time"],
    )
    # Deduplicate GTFS trips by arrival time: two trips at the exact same time
    # represent the same physical train (split/join service) — keep only the first.
    seen_gtfs_times = set()
    upcoming = []
    for a in upcoming_raw:
        if a["time"] not in seen_gtfs_times:
            seen_gtfs_times.add(a["time"])
            upcoming.append(a)

    tib_agency = config.TIB_AGENCY_ID
    tib_routes = config.TIB_ROUTE_SHORT_NAMES
    # Resolve Trafikverket location signature once, outside the loop
    loc_sig = config.TRAFIKVERKET_STATIONS.get(stop_id, "")
    if not loc_sig:
        for qid in query_ids:
            ls = config.TRAFIKVERKET_STATIONS.get(qid, "")
            if ls:
                loc_sig = ls
                break
    arrs = []
    used_tv_arr_keys = set()  # prevent two GTFS trips matching the same TV announcement
    for a in upcoming:
        route_id = a["route_id"]
        trip_id = a["trip_id"]
        if not route_id:
            route_id = trips.get(trip_id, {}).get("route_id", "")
        route = routes.get(route_id, {})
        if only_trains:
            rt = route.get("route_type", 3)
            if not (rt == 2 or 100 <= rt <= 199):
                continue
            if tib_routes:
                if route.get("route_short_name", "") not in tib_routes:
                    continue
            elif tib_agency and route.get("agency_id", "") != tib_agency:
                continue
        headsign = trip_headsigns.get(trip_id, "") or route.get("route_long_name", "")
        origin = trip_origin_map.get(trip_id, "")
        trip_short_name = (
            trips.get(trip_id, {}).get("trip_short_name", "")
            or rt_trip_short_names.get(trip_id, "")
            or a.get("rt_trip_short_name", "")
        )
        rsn = route.get("route_short_name", "?")
        color = config.ROUTE_COLOR_OVERRIDES.get(rsn) or route.get("route_color", "0074D9")

        # Enrich from Trafikverket TrainAnnouncement if stop is mapped
        tv_track = ""
        tv_canceled = False
        tv_deviation = []
        tv_other_info = []
        tv_preliminary = False
        tv_traffic_type = ""
        tv_arr_operator = ""
        tv_arr_product = ""
        tv_rt_arr_time = None
        tv_arr_sched_override = None
        tv_arr_track_changed = False
        if loc_sig and tv_ann.get(loc_sig):
            # Use static scheduled time for matching when available (RT time may be delayed)
            arr_time = a.get("sched_time") or a["time"]
            tv_ops = config.TRAFIKVERKET_OPERATORS
            best_tv = None
            best_diff = float("inf")
            # First pass: preferred operators
            if tv_ops:
                for tv_arr in tv_ann[loc_sig].get("arrivals", []):
                    if tv_arr.get("operator", "") not in tv_ops:
                        continue
                    tv_key = (tv_arr["train_number"], tv_arr["scheduled_time"])
                    if tv_key in used_tv_arr_keys:
                        continue
                    diff = abs(tv_arr["scheduled_time"] - arr_time)
                    if diff < best_diff and diff <= 600:
                        best_diff = diff
                        best_tv = tv_arr
            # Second pass: any operator.
            # Window: tight 3-min when preferred operators are configured;
            # generous 10-min when no operator filter is set.
            fallback_window = 180 if tv_ops else 600
            if best_tv is None:
                best_diff = float("inf")
                for tv_arr in tv_ann[loc_sig].get("arrivals", []):
                    tv_key = (tv_arr["train_number"], tv_arr["scheduled_time"])
                    if tv_key in used_tv_arr_keys:
                        continue
                    diff = abs(tv_arr["scheduled_time"] - arr_time)
                    if diff < best_diff and diff <= fallback_window:
                        best_diff = diff
                        best_tv = tv_arr
            if best_tv:
                used_tv_arr_keys.add((best_tv["train_number"], best_tv["scheduled_time"]))
                trip_short_name = best_tv["train_number"]
                tv_arr_operator = best_tv.get("operator", "")
                tv_arr_product = best_tv.get("product", "")
                if not config.ROUTE_COLOR_OVERRIDES.get(rsn):
                    op_l = tv_arr_operator.lower()
                    pr_l = tv_arr_product.lower()
                    if "mälartåg" in op_l or "mälartåg" in pr_l:
                        color = "005B99"
                    elif "sj" in op_l:
                        color = "D4004C"
                    elif "arriva" in op_l or "bergslagen" in pr_l:
                        color = "E87722"
                tv_track = best_tv["track"]
                tv_canceled = best_tv["canceled"]
                tv_deviation = best_tv["deviation"]
                tv_other_info = best_tv.get("other_info", [])
                tv_preliminary = best_tv.get("preliminary", False)
                tv_traffic_type = best_tv.get("traffic_type", "")
                tv_rt_arr_time = best_tv.get("realtime_time")
                tv_arr_sched_override = best_tv["scheduled_time"]
                tv_arr_track_changed = any("spår" in t.lower() for t in tv_deviation)
                if best_tv["origin_sig"]:
                    origin = tv_stations.get(best_tv["origin_sig"], {}).get("name", best_tv["origin_sig"])

        # Skip arrivals that originate from this very station
        if origin and origin in dest_stop_names:
            continue

        arr_sched_time = tv_arr_sched_override if tv_arr_sched_override else (a.get("sched_time") or a["time"])
        arrs.append({
            "route_short_name": rsn,
            "trip_short_name": trip_short_name,
            "route_color": color,
            "route_text_color": route.get("route_text_color", "FFFFFF"),
            "operator": tv_arr_operator,
            "product": tv_arr_product,
            "origin": origin,
            "arrival_time": tv_rt_arr_time if tv_rt_arr_time else arr_sched_time,
            "scheduled_time": arr_sched_time,
            "is_realtime": bool(tv_rt_arr_time),
            "trip_id": trip_id,
            "platform": tv_track,
            "track_changed": tv_arr_track_changed,
            "canceled": tv_canceled,
            "deviation": tv_deviation,
            "other_info": tv_other_info,
            "preliminary": tv_preliminary,
            "traffic_type": tv_traffic_type,
        })
        if len(arrs) >= limit:
            break

    # TV-only arrivals: operators not in GTFS (e.g. Mälartåg, SJ).
    if only_trains and loc_sig and tv_ann.get(loc_sig):
        for tv_arr in tv_ann[loc_sig].get("arrivals", []):
            tv_key = (tv_arr["train_number"], tv_arr["scheduled_time"])
            if tv_key in used_tv_arr_keys:
                continue
            if tv_arr["scheduled_time"] < now - 300:
                continue
            op = (tv_arr.get("operator") or "").lower()
            pr = (tv_arr.get("product") or "").lower()
            # Skip arrivals originating at this station
            origin_name = tv_stations.get(tv_arr.get("origin_sig", ""), {}).get("name", "") if tv_arr.get("origin_sig") else ""
            if origin_name and origin_name in dest_stop_names:
                continue
            if "mälartåg" in op or "mälartåg" in pr:
                tv_color, tv_rsn = "005B99", "MÅ"
            elif "sj" in op:
                tv_color, tv_rsn = "D4004C", "SJ"
            elif "arriva" in op or "bergslagen" in pr:
                tv_color, tv_rsn = "E87722", "TiB"
            elif "snälltåget" in op:
                tv_color, tv_rsn = "1A1A1A", "SNÅ"
            else:
                tv_color, tv_rsn = "555555", "?"
            sched_t = tv_arr["scheduled_time"]
            rt_t = tv_arr.get("realtime_time")
            track_chg = any("spår" in t.lower() for t in tv_arr.get("deviation", []))
            arrs.append({
                "route_short_name": tv_rsn,
                "trip_short_name": tv_arr["train_number"],
                "route_color": tv_color,
                "route_text_color": "FFFFFF",
                "operator": tv_arr.get("operator", ""),
                "product": tv_arr.get("product", ""),
                "origin": origin_name,
                "arrival_time": rt_t if rt_t else sched_t,
                "scheduled_time": sched_t,
                "is_realtime": bool(rt_t),
                "trip_id": "",
                "platform": tv_arr.get("track", ""),
                "track_changed": track_chg,
                "canceled": tv_arr.get("canceled", False),
                "deviation": tv_arr.get("deviation", []),
                "other_info": tv_arr.get("other_info", []),
                "preliminary": tv_arr.get("preliminary", False),
                "traffic_type": tv_arr.get("traffic_type", ""),
            })
        arrs.sort(key=lambda x: x["arrival_time"])

    # Deduplicate: same scheduled time + same origin = same physical train
    # (happens when a GTFS trip split/join creates two entries for one train)
    seen_arr_keys = set()
    deduped_arrs = []
    for entry in arrs:
        key = (entry["scheduled_time"], entry["origin"])
        if key not in seen_arr_keys:
            seen_arr_keys.add(key)
            deduped_arrs.append(entry)
    arrs = deduped_arrs[:limit]

    # Annotate each arrival with GPS-confirmed at-station status.
    # Trafikverket's TimeAtLocation fires at the operational boundary (driftsplatsgräns),
    # which can be 1-2 km from the platform for trains approaching from the north.
    # gps_at_station = True  → GPS confirms train is within _GPS_ARRIVED_M of station
    # gps_at_station = False → GPS says train is still far away — don't show "Ankommit"
    # gps_at_station = None  → no GPS data available — fall back to time-based display
    for entry in arrs:
        entry["gps_at_station"] = _gps_at_station(entry.get("trip_short_name", ""))

    return jsonify({"stop_id": stop_id, "arrivals": arrs, "count": len(arrs)})


@app.route("/api/station-messages/<stop_id>")
def station_messages(stop_id):
    """Return current Trafikverket TrainStationMessages for a stop.

    Response:
      announcements    – Utrop messages (station-wide, show as banner)
      platform_messages – dict {track: [messages]} for Plattformsskylt
      station_name     – human-readable station name
    """
    with _lock:
        tv_messages = dict(_data.get("tv_messages", {}))
        tv_stations = dict(_data.get("tv_stations", {}))

    loc_sig = config.TRAFIKVERKET_STATIONS.get(stop_id, "")
    if not loc_sig:
        # Try child stops — parent station may be passed
        with _lock:
            all_stops = _data["stops"]
        target = all_stops.get(stop_id, {})
        if target.get("location_type", 0) == 1:
            for child_id in [s["stop_id"] for s in all_stops.values()
                              if s.get("parent_station") == stop_id]:
                loc_sig = config.TRAFIKVERKET_STATIONS.get(child_id, "")
                if loc_sig:
                    break

    all_msgs = tv_messages.get(loc_sig, [])

    # Utrop = station-wide announcement banner
    announcements = [m for m in all_msgs if m.get("media_type") == "Utrop"]

    # Plattformsskylt = per-track messages shown on matching train rows
    platform_messages: dict[str, list] = {}
    for m in all_msgs:
        if m.get("media_type") == "Plattformsskylt":
            for track in m.get("tracks", []):
                platform_messages.setdefault(track, []).append({
                    "body": m["body"],
                    "status": m.get("status", "Normal"),
                })

    return jsonify({
        "announcements": announcements,
        "platform_messages": platform_messages,
        "station_name": tv_stations.get(loc_sig, {}).get("name", "") if loc_sig else "",
    })

def debug_tv_announcements():
    """Show cached Trafikverket TrainAnnouncement data."""
    with _lock:
        ann = dict(_data["tv_announcements"])
        last_poll = _data["tv_last_poll"]
        last_error = _data["tv_last_error"]
        positions_count = len(_data["tv_positions"])
    summary = {}
    for loc_sig, bucket in ann.items():
        summary[loc_sig] = {
            "departures": len(bucket.get("departures", [])),
            "arrivals": len(bucket.get("arrivals", [])),
            "sample_departures": bucket.get("departures", [])[:3],
        }
    return jsonify({
        "last_poll": last_poll,
        "last_error": last_error,
        "tv_positions_count": positions_count,
        "configured_stations": config.TRAFIKVERKET_STATIONS,
        "announcements": summary,
    })

def debug_tv_match():
    """Find GTFS stop_id ↔ Trafikverket LocationSignature matches by name/proximity.

    Query params:
        q=örebro  — filter by partial name (case-insensitive)
        lat=59.27&lon=15.21  — find closest TV station to coordinate
    """
    q = request.args.get("q", "").lower()
    lat = request.args.get("lat", type=float)
    lon = request.args.get("lon", type=float)

    with _lock:
        tv_stations = dict(_data["tv_stations"])
        gtfs_stops = dict(_data["stops"])

    # Search TV stations by name
    tv_results = []
    for sig, info in tv_stations.items():
        name = info.get("name", "")
        if q and q not in name.lower():
            continue
        tv_results.append({"sig": sig, "name": name, "lat": info.get("lat"), "lon": info.get("lon")})

    # If lat/lon given, find nearest TV station
    nearest_tv = None
    if lat is not None and lon is not None:
        best_dist = float("inf")
        for sig, info in tv_stations.items():
            slat, slon = info.get("lat"), info.get("lon")
            if slat is None or slon is None:
                continue
            d = ((slat - lat) ** 2 + (slon - lon) ** 2) ** 0.5
            if d < best_dist:
                best_dist = d
                nearest_tv = {"sig": sig, "name": info["name"], "dist_deg": round(d, 4)}

    # Search GTFS stops by name
    gtfs_results = []
    for stop_id, s in gtfs_stops.items():
        name = s.get("stop_name", "")
        if q and q not in name.lower():
            continue
        if s.get("location_type", 0) == 1:  # parent stations first
            gtfs_results.insert(0, {"stop_id": stop_id, "name": name,
                                     "lat": s.get("stop_lat"), "lon": s.get("stop_lon"),
                                     "type": "parent"})
        else:
            gtfs_results.append({"stop_id": stop_id, "name": name,
                                  "lat": s.get("stop_lat"), "lon": s.get("stop_lon"),
                                  "type": "stop"})

    return jsonify({
        "query": q or None,
        "tv_stations": tv_results[:30],
        "gtfs_stops": gtfs_results[:30],
        "nearest_tv": nearest_tv,
        "hint": "Set TRAFIKVERKET_STATIONS=<gtfs_stop_id>:<LocationSig> in .env",
    })

def debug_trains():
    """Show current Oxyfi train state."""
    trains = oxyfi.get_trains()
    return jsonify({
        "oxyfi_key_set": bool(config.OXYFI_API_KEY),
        "train_count": len(trains),
        "last_update": oxyfi._last_update,
        "trains": trains,
    })

def debug_tv_positions():
    """Show raw Trafikverket TrainPosition cache and geo-filtered trains within radius."""
    with _lock:
        raw_positions = list(_data.get("tv_positions", []))
        last_poll = _data.get("tv_last_poll", 0)
        last_error = _data.get("tv_last_error")
        sse_state = _data.get("tv_sse_state", "disconnected")

    filtered = _tv_trains_from_positions()

    # Count operator distribution in raw positions
    op_counts: dict = {}
    for p in raw_positions:
        op = p.get("operator") or "okänd"
        op_counts[op] = op_counts.get(op, 0) + 1

    return jsonify({
        "api_key_set": bool(config.TRAFIKVERKET_API_KEY),
        "config": {
            "center_lat": config.TV_POSITION_CENTER_LAT,
            "center_lon": config.TV_POSITION_CENTER_LON,
            "radius_km": config.TV_POSITION_RADIUS_KM,
        },
        "sse_state": sse_state,
        "last_update": last_poll,
        "last_error": last_error,
        "raw_count": len(raw_positions),
        "filtered_count": len(filtered),
        "operator_counts": dict(sorted(op_counts.items(), key=lambda x: -x[1])),
        "trains": sorted(filtered, key=lambda t: t.get("label", "")),
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

# --- Startup ---

_prev_vehicles: dict = {}   # vehicle_id -> vehicle dict, for delta computation

def _push_train_positions():
    """Push merged bus+train positions via SSE every 5 s.

    Each data source is wrapped in its own try/except so that a failure in
    one source (e.g. train merge crash, Oxyfi disconnect) never silences the
    other sources. Buses always stream even when trains are broken, and vice versa.

    Emits two SSE events per tick:
      - ``vehicles``       — full list (backward-compat with old clients)
      - ``vehicles_delta`` — only changed/removed vehicles (≈80-95% smaller payload)
    """
    global _prev_vehicles

    trains = []
    try:
        oxyfi_trains = oxyfi.get_trains()
        tv_trains = _tv_trains_from_positions()
        trains = _merge_trains(oxyfi_trains, tv_trains)
    except Exception as exc:
        print(f"[sse] train source error (buses will still push): {exc}")

    buses = []
    ts = int(time.time())
    try:
        with _lock:
            vehicle_list = list(_data["vehicles"])
            ts = _data["last_vehicle_update"]
        buses = _enrich_vehicles(vehicle_list)
    except Exception as exc:
        print(f"[sse] bus source error: {exc}")

    combined = buses + trains
    _push_sse("vehicles", {"vehicles": combined, "timestamp": ts, "count": len(combined)})

    # --- Delta event ---
    current: dict = {v["vehicle_id"]: v for v in combined if v.get("vehicle_id")}
    prev_ids = set(_prev_vehicles)
    curr_ids = set(current)

    removed = list(prev_ids - curr_ids)
    updated = [
        v for vid, v in current.items()
        if vid not in _prev_vehicles or _prev_vehicles[vid] != v
    ]
    if updated or removed:
        _push_sse("vehicles_delta", {
            "updated": updated,
            "removed": removed,
            "timestamp": ts,
        })
    _prev_vehicles = current

def _update_tv_positions(new_positions: list) -> None:
    """Merge a batch of streaming TrainPosition updates into _data['tv_positions'].

    Entries with deleted=True remove the train from the cache; all others
    replace (or insert) the entry for that train_number.
    """
    with _lock:
        current = {p["train_number"]: p
                   for p in _data.get("tv_positions", [])
                   if p.get("train_number")}
        for p in new_positions:
            tn = p.get("train_number")
            if not tn:
                continue
            if p.get("deleted"):
                current.pop(tn, None)
            else:
                current[tn] = p
        _data["tv_positions"] = list(current.values())
    # TV position ticks go straight to SSE — no API cache to invalidate here.

def _run_tv_position_stream() -> None:
    """Background thread: subscribe to TrainPosition changes via Trafikverket SSE.

    Flow (as recommended by TRV docs):
      1. POST with sseurl=true  → get snapshot of current positions + SSEURL
      2. Connect to SSEURL       → receive all future changes in real time
      3. On 404 (endpoint expired) → go to step 1
      4. On other errors           → reconnect to same SSEURL + lasteventid
                                     with exponential back-off
    """
    import requests as _requests  # local import to avoid circular at module level

    last_event_id: str | None = None
    sseurl: str | None = None
    backoff = 5

    while True:
        try:
            if not sseurl:
                positions, sseurl = tv_api.fetch_position_sseurl()
                if not positions and not sseurl:
                    # API key missing or fetch failed — wait and retry
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 300)
                    continue
                with _lock:
                    _data["tv_positions"] = positions
                    _data["tv_last_poll"] = int(time.time())
                    _data["tv_last_error"] = None
                last_event_id = None  # fresh endpoint, start from beginning
                if not sseurl:
                    print("tv-sse: no SSEURL returned — position streaming unavailable")
                    return

            print(f"tv-sse: connecting (last_event_id={last_event_id})")
            with _lock:
                _data["tv_sse_state"] = "connected"
            for event_id, positions in tv_api.iter_position_stream(sseurl, last_event_id):
                last_event_id = event_id
                backoff = 5  # reset on successful messages
                _update_tv_positions(positions)
                with _lock:
                    _data["tv_last_poll"] = int(time.time())
                    _data["tv_last_error"] = None
                    _data["tv_sse_state"] = "connected"

            # iter_position_stream exhausted without error → stream closed cleanly
            print("tv-sse: stream closed, reconnecting")
            with _lock:
                _data["tv_sse_state"] = "reconnecting"
            time.sleep(2)

        except _requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else 0
            if status == 404:
                print("tv-sse: endpoint expired (404), recreating")
                sseurl = None
                last_event_id = None
                # no sleep — recreate immediately
            else:
                print(f"tv-sse: HTTP {status}, recreating endpoint")
                with _lock:
                    _data["tv_last_error"] = f"HTTP {status}"
                sseurl = None
                last_event_id = None
                time.sleep(backoff)
                backoff = min(backoff * 2, 300)
            with _lock:
                _data["tv_sse_state"] = "reconnecting"

        except Exception as exc:
            print(f"tv-sse: error: {exc}")
            with _lock:
                _data["tv_last_error"] = str(exc)
                _data["tv_sse_state"] = "reconnecting"
            # Keep sseurl + last_event_id so we can resume from where we left off
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)

def _init_trafikverket():
    """Load TrainStation lookup table, start SSE position stream, do first announcement poll."""
    stations = tv_api.fetch_train_stations()
    with _lock:
        _data["tv_stations"] = stations
    threading.Thread(target=_run_tv_position_stream, daemon=True, name="tv-sse").start()
    _poll_trafikverket()

def _poll_trafikverket():
    """Fetch TrainAnnouncement + StationMessages (positions come via SSE stream)."""
    loc_sigs = list(config.TRAFIKVERKET_STATIONS.values())
    if not loc_sigs:
        return

    try:
        announcements = tv_api.fetch_announcements(
            loc_sigs, minutes_ahead=config.TRAFIKVERKET_LOOKAHEAD_MINUTES
        )
        messages = tv_api.fetch_station_messages(loc_sigs)

        with _lock:
            if announcements:
                _data["tv_announcements"] = announcements
            _data["tv_messages"] = messages
            _data["tv_last_error"] = None
        # Announcement updates affect departure boards — invalidate dep caches only.
        _api_cache.invalidate_prefix("dep")
    except Exception as exc:
        print(f"tv-poll error: {exc}")
        with _lock:
            _data["tv_last_error"] = str(exc)

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
    # Push live vehicle positions via SSE at the same cadence as RT polling
    scheduler.add_job(_push_train_positions, "interval", seconds=config.RT_POLL_SECONDS, max_instances=1)
    # Poll Trafikverket positions (always) and announcements (when stations configured)
    if config.TRAFIKVERKET_API_KEY:
        scheduler.add_job(_poll_trafikverket, "interval",
                          seconds=config.TRAFIKVERKET_POLL_SECONDS, max_instances=1)
    scheduler.start()

    threading.Thread(target=poll_realtime, daemon=True).start()
    oxyfi.start()
    if config.TRAFIKVERKET_API_KEY:
        threading.Thread(target=_init_trafikverket, daemon=True).start()

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
