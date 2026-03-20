"""Stops Blueprint — /api/stops*, /api/nearby-departures endpoints.

All endpoints here are reads of GTFS static + RT data with no side effects.
"""

import math
import time

from flask import Blueprint, jsonify, request

import config
from store import _data, _lock, _cache_get, _cache_set
from trip_utils import merge_rt_static

bp = Blueprint("stops", __name__)


@bp.route("/api/stops")
def stops():
    """Return stops, optionally filtered by route_ids query param."""
    route_ids_param = request.args.get("route_ids", "")[:500]
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


@bp.route("/api/stops/stations")
def stations():
    """Return only parent stations (location_type=1)."""
    with _lock:
        stop_list = list(_data["stops"].values())
    result = [s for s in stop_list if s["location_type"] == 1]
    return jsonify({"stops": result, "count": len(result)})


@bp.route("/api/stops/next-departure")
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

    merged = {}
    all_stops = set(static_departures) | set(rt_departures)
    for stop_id in all_stops:
        rt_deps = rt_departures.get(stop_id, [])
        merged[stop_id] = merge_rt_static(rt_deps, static_departures.get(stop_id, []))

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


@bp.route("/api/nearby-departures")
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

    groups = {}
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
        all_raw = []
        for sid in grp["stop_ids"]:
            all_raw.extend(merge_rt_static(
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
