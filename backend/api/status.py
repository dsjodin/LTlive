"""Status Blueprint — health, status, alerts, line info, stats endpoints."""

import threading
import time

from flask import Blueprint, jsonify, request

import config
import gtfs_loader
import stats as _stats
from stores.gtfs_store import gtfs_store
from stores.site_config_store import site_config
from stores.vehicle_store import vehicle_store
from store import _data, _lock

bp = Blueprint("status", __name__)

# Stop-sequence cache for line_departures — scoped here since only used by this blueprint
_stop_seq_cache: dict = {}
_stop_seq_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Health + status
# ---------------------------------------------------------------------------

@bp.route("/api/health")
def health():
    return jsonify({"status": "ok", "gtfs_loaded": gtfs_store.loaded})


@bp.route("/api/status")
def status():
    """Public status — only the fields the frontend needs. No internal details."""
    with gtfs_store.lock:
        gtfs_error   = gtfs_store.error
        routes_count = len(gtfs_store.routes)
        gtfs_loaded  = gtfs_store.loaded

    cfg = site_config.frontend()

    return jsonify({
        "gtfs_loaded":             gtfs_loaded,
        "gtfs_error":              bool(gtfs_error),
        "routes_count":            routes_count,
        "nearby_radius_meters":    config.NEARBY_RADIUS_METERS,
        "frontend_poll_interval_ms": config.FRONTEND_POLL_INTERVAL_MS,
        "map_center_lat":          cfg["map"]["center_lat"],
        "map_center_lon":          cfg["map"]["center_lon"],
        "map_default_zoom":        cfg["map"]["default_zoom"],
        # Site config fields
        "site_name":               cfg["site_name"],
        "operator":                cfg["operator"],
        "lines":                   cfg["lines"],
        "line_colors":             cfg["line_colors"],
        "station_presets":         cfg["station_presets"],
        "features":                cfg["features"],
    })


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------

@bp.route("/api/alerts")
def alerts():
    """Return current service alerts."""
    with vehicle_store.lock:
        alert_list = list(vehicle_store.alerts)
    return jsonify({"alerts": alert_list, "count": len(alert_list)})


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

@bp.route("/api/stats/visit", methods=["POST"])
def stats_visit():
    data = request.get_json(silent=True) or {}
    session_id = str(data.get("session_id", ""))[:64]
    page       = str(data.get("page", "/"))[:200]
    ip = (
        request.headers.get("X-Forwarded-For", request.remote_addr or "")
        .split(",")[0]
        .strip()
    )
    if session_id:
        _stats.record_visit(session_id, page, ip)
    return "", 204


@bp.route("/api/stats/leave", methods=["POST"])
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


@bp.route("/api/stats")
def stats_view():
    return jsonify(_stats.get_stats())


# ---------------------------------------------------------------------------
# Line detail + departures (used by line panel on the map)
# ---------------------------------------------------------------------------

@bp.route("/api/line/<route_id>")
def line_detail(route_id):
    """Return detailed info for a specific route/line."""
    with gtfs_store.lock:
        all_routes   = dict(gtfs_store.routes)
        trips        = dict(gtfs_store.trips)
        all_shapes   = dict(gtfs_store.shapes)
    with vehicle_store.lock:
        vehicle_list = list(vehicle_store.vehicles)

    route = all_routes.get(route_id)
    if not route:
        return jsonify({"error": "Route not found"}), 404

    route_trips  = {tid: t for tid, t in trips.items() if t["route_id"] == route_id}
    shape_ids    = set(t["shape_id"] for t in route_trips.values() if t["shape_id"])
    route_shapes = {sid: all_shapes[sid] for sid in shape_ids if sid in all_shapes}
    active       = [
        v for v in vehicle_list
        if v.get("route_id") == route_id
        or trips.get(v.get("trip_id", ""), {}).get("route_id") == route_id
    ]

    return jsonify({
        "route":           route,
        "shapes":          route_shapes,
        "active_vehicles": active,
        "trip_count":      len(route_trips),
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

    with gtfs_store.lock:
        trips = dict(gtfs_store.trips)
        stops = dict(gtfs_store.stops)

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

    rep_trip = max(trip_data, key=lambda tid: len(trip_data[tid]))
    seq = [
        {
            "stop_id":        s["stop_id"],
            "stop_name":      stops.get(s["stop_id"], {}).get("stop_name", s["stop_id"]),
            "departure_time": s.get("departure_time", "") or s.get("arrival_time", ""),
        }
        for s in trip_data[rep_trip]
    ]

    with _stop_seq_lock:
        _stop_seq_cache[key] = seq
    return seq


@bp.route("/api/line-departures/<route_id>")
def line_departures(route_id):
    """Return stop-by-stop timetable for each direction of a route."""
    with gtfs_store.lock:
        trip_headsigns = dict(gtfs_store.trip_headsigns)
        routes         = dict(gtfs_store.routes)
        stops          = dict(gtfs_store.stops)
        trips          = dict(gtfs_store.trips)
    with vehicle_store.lock:
        stop_departures = dict(vehicle_store.stop_departures)
    now = int(time.time())

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
            if static:
                dir_id = str(static.get("direction_id", "0") or "0")
            else:
                dir_id = str(dep.get("direction_id") or "0")
            if tid not in trip_rt:
                trip_rt[tid] = {"dir": dir_id, "stop_times": {}}
            existing = trip_rt[tid]["stop_times"].get(stop_id)
            if existing is None or t < existing[0]:
                trip_rt[tid]["stop_times"][stop_id] = (t, dep.get("is_realtime", False))

    dir_trips = {}
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

        merged: dict = {}
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

        seq = _get_stop_sequence(route_id, dir_id)
        if seq:
            stops_out = []
            for ss in seq:
                sid = ss["stop_id"]
                if sid not in merged:
                    continue
                t, is_rt = merged[sid]
                stops_out.append({
                    "stop_id":    sid,
                    "stop_name":  ss["stop_name"],
                    "time":       t,
                    "minutes":    max(0, round((t - now) / 60)),
                    "is_realtime": is_rt,
                })
        else:
            stops_out = [
                {
                    "stop_id":    sid,
                    "stop_name":  stops.get(sid, {}).get("stop_name", sid),
                    "time":       t,
                    "minutes":    max(0, round((t - now) / 60)),
                    "is_realtime": is_rt,
                }
                for sid, (t, is_rt) in sorted(merged.items(), key=lambda x: x[1][0])
            ]

        if stops_out:
            directions_out.append({
                "direction_id": dir_id,
                "headsign":     headsign,
                "stops":        stops_out,
            })

    route_info = routes.get(route_id, {})
    return jsonify({
        "route_id":         route_id,
        "route_short_name": route_info.get("route_short_name", ""),
        "route_long_name":  route_info.get("route_long_name", ""),
        "route_color":      route_info.get("route_color", "0074D9"),
        "route_text_color": route_info.get("route_text_color", "FFFFFF"),
        "directions":       directions_out,
    })
