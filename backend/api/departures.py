"""Departures Blueprint — /api/departures, /api/arrivals, /api/station-messages.

Train-specific enrichment (Trafikverket announcements, track info, cancellations)
lives here alongside the GTFS departure/arrival logic so bus and train data
can be maintained and extended independently of the map/status endpoints.
"""

import math
import time

from flask import Blueprint, jsonify, request

import config
import oxyfi
from stores.gtfs_store import gtfs_store
from stores.train_store import train_store
from stores.vehicle_store import vehicle_store
from store import _cache_get, _cache_set
from trip_utils import merge_rt_static as _merge_rt_static

bp = Blueprint("departures", __name__)


# ---------------------------------------------------------------------------
# /api/departures/<stop_id>
# ---------------------------------------------------------------------------

@bp.route("/api/departures/<stop_id>")
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

    with gtfs_store.lock:
        all_stops_data      = dict(gtfs_store.stops)
        routes              = dict(gtfs_store.routes)
        trips               = dict(gtfs_store.trips)
        trip_headsigns      = dict(gtfs_store.trip_headsigns)
        rt_trip_short_names = dict(gtfs_store.rt_trip_short_names)
        static_stop_deps    = dict(gtfs_store.static_stop_departures)

    with vehicle_store.lock:
        stop_departures = dict(vehicle_store.stop_departures)

    with train_store.lock:
        tv_ann      = dict(train_store.announcements)
        tv_stations = dict(train_store.stations)

    target_stop = all_stops_data.get(stop_id, {})
    if target_stop.get("location_type", 0) == 1:
        child_ids = [
            s["stop_id"] for s in all_stops_data.values()
            if s.get("parent_station") == stop_id
        ]
        query_ids = child_ids if child_ids else [stop_id]
    else:
        query_ids = [stop_id]

    rt_deps, static_deps = [], []
    for qid in query_ids:
        platform_code = all_stops_data.get(qid, {}).get("platform_code", "")
        for dep in stop_departures.get(qid, []):
            rt_deps.append({**dep, "_platform": platform_code})
        for dep in static_stop_deps.get(qid, []):
            static_deps.append({**dep, "_platform": platform_code})

    raw = _merge_rt_static(rt_deps, static_deps)
    upcoming = sorted(
        [d for d in raw if d["time"] >= now - 600],
        key=lambda d: d["time"],
    )

    tib_agency = config.TIB_AGENCY_ID
    tib_routes = config.TIB_ROUTE_SHORT_NAMES
    loc_sig = config.TRAFIKVERKET_STATIONS.get(stop_id, "")
    if not loc_sig:
        for qid in query_ids:
            ls = config.TRAFIKVERKET_STATIONS.get(qid, "")
            if ls:
                loc_sig = ls
                break

    deps = []
    used_tv_dep_keys = set()
    for d in upcoming:
        route_id = d["route_id"]
        trip_id  = d["trip_id"]
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

        headsign        = trip_headsigns.get(trip_id, "") or route.get("route_long_name", "")
        trip_short_name = (
            trips.get(trip_id, {}).get("trip_short_name", "")
            or rt_trip_short_names.get(trip_id, "")
            or d.get("rt_trip_short_name", "")
        )
        rsn   = route.get("route_short_name", "?")
        color = config.ROUTE_COLOR_OVERRIDES.get(rsn) or route.get("route_color", "0074D9")

        tv_track = tv_canceled = tv_track_changed = tv_preliminary = False
        tv_deviation = tv_other_info = tv_via = []
        tv_traffic_type = tv_operator = tv_product = ""
        tv_rt_time = tv_sched_override = None
        best_tv = None
        tv_track = ""

        if loc_sig and tv_ann.get(loc_sig):
            dep_time  = d.get("sched_time") or d["time"]
            tv_ops    = config.TRAFIKVERKET_OPERATORS
            best_diff = float("inf")
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
                trip_short_name  = best_tv["train_number"]
                tv_operator      = best_tv.get("operator", "")
                tv_product       = best_tv.get("product", "")
                if not config.ROUTE_COLOR_OVERRIDES.get(rsn):
                    op_l, pr_l = tv_operator.lower(), tv_product.lower()
                    if "mälartåg" in op_l or "mälartåg" in pr_l:
                        color = "005B99"
                    elif "sj" in op_l:
                        color = "D4004C"
                    elif "arriva" in op_l or "bergslagen" in pr_l:
                        color = "E87722"
                tv_track          = best_tv["track"]
                tv_canceled       = best_tv["canceled"]
                tv_deviation      = best_tv["deviation"]
                tv_other_info     = best_tv.get("other_info", [])
                tv_preliminary    = best_tv.get("preliminary", False)
                tv_traffic_type   = best_tv.get("traffic_type", "")
                tv_rt_time        = best_tv.get("realtime_time")
                tv_sched_override = best_tv["scheduled_time"]
                tv_track_changed  = any("spår" in t.lower() for t in tv_deviation)
                if best_tv["dest_sig"]:
                    headsign = tv_stations.get(best_tv["dest_sig"], {}).get("name", best_tv["dest_sig"])
                tv_via = []
                for vsig in best_tv.get("via_sigs", [])[:3]:
                    tv_via.append(tv_stations.get(vsig, {}).get("name", vsig))

        if best_tv and best_tv.get("has_actual_time") and tv_rt_time and tv_rt_time < now - 60:
            continue

        platform  = tv_track or d.get("_platform", "")
        sched_time = tv_sched_override if tv_sched_override else (d.get("sched_time") or d["time"])
        rt_time    = tv_rt_time if tv_sched_override else (d["time"] if d["is_realtime"] else None)
        actual_dep = rt_time if rt_time else sched_time
        deps.append({
            "route_short_name": rsn,
            "trip_short_name":  trip_short_name,
            "route_color":      color,
            "route_text_color": route.get("route_text_color", "FFFFFF"),
            "operator":         tv_operator,
            "product":          tv_product,
            "headsign":         headsign,
            "departure_time":   actual_dep,
            "scheduled_time":   sched_time,
            "delay_minutes":    round((actual_dep - sched_time) / 60) if rt_time else 0,
            "is_realtime":      bool(rt_time),
            "trip_id":          trip_id,
            "platform":         platform,
            "track_changed":    tv_track_changed,
            "canceled":         tv_canceled,
            "deviation":        tv_deviation,
            "other_info":       tv_other_info,
            "preliminary":      tv_preliminary,
            "traffic_type":     tv_traffic_type,
            "via":              tv_via,
        })
        if len(deps) >= limit:
            break

    # TV-only trains: operators not in GTFS (e.g. Mälartåg, SJ)
    if only_trains and loc_sig and tv_ann.get(loc_sig):
        for tv_dep in tv_ann[loc_sig].get("departures", []):
            tv_key = (tv_dep["train_number"], tv_dep["scheduled_time"])
            if tv_key in used_tv_dep_keys:
                continue
            if tv_dep["scheduled_time"] < now - 60:
                continue
            if tv_dep.get("has_actual_time") and tv_dep.get("realtime_time") and tv_dep["realtime_time"] < now - 60:
                continue
            op, pr = (tv_dep.get("operator") or "").lower(), (tv_dep.get("product") or "").lower()
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
            dest_name  = tv_stations.get(tv_dep.get("dest_sig", ""), {}).get("name", "") if tv_dep.get("dest_sig") else ""
            via_names  = [tv_stations.get(v, {}).get("name", v) for v in tv_dep.get("via_sigs", [])[:3]]
            sched_t    = tv_dep["scheduled_time"]
            rt_t       = tv_dep.get("realtime_time")
            track_chg  = any("spår" in t.lower() for t in tv_dep.get("deviation", []))
            tv_actual  = rt_t if rt_t else sched_t
            deps.append({
                "route_short_name": tv_rsn,
                "trip_short_name":  tv_dep["train_number"],
                "route_color":      tv_color,
                "route_text_color": "FFFFFF",
                "operator":         tv_dep.get("operator", ""),
                "product":          tv_dep.get("product", ""),
                "headsign":         dest_name,
                "departure_time":   tv_actual,
                "scheduled_time":   sched_t,
                "delay_minutes":    round((tv_actual - sched_t) / 60) if rt_t else 0,
                "is_realtime":      bool(rt_t),
                "trip_id":          "",
                "platform":         tv_dep.get("track", ""),
                "track_changed":    track_chg,
                "canceled":         tv_dep.get("canceled", False),
                "deviation":        tv_dep.get("deviation", []),
                "other_info":       tv_dep.get("other_info", []),
                "preliminary":      tv_dep.get("preliminary", False),
                "traffic_type":     tv_dep.get("traffic_type", ""),
                "via":              via_names,
            })
        deps.sort(key=lambda x: x["departure_time"])

    # Deduplicate: same scheduled time + same headsign = same physical train
    seen = set()
    deduped = []
    for entry in deps:
        key = (entry["scheduled_time"], entry["headsign"])
        if key not in seen:
            seen.add(key)
            deduped.append(entry)
    deps = deduped[:limit]

    result = {"stop_id": stop_id, "departures": deps, "count": len(deps)}
    _cache_set(cache_key, result)
    return jsonify(result)


# ---------------------------------------------------------------------------
# /api/arrivals/<stop_id>
# ---------------------------------------------------------------------------

@bp.route("/api/arrivals/<stop_id>")
def arrivals_for_stop(stop_id):
    """Return upcoming train arrivals for a stop, enriched with origin info."""
    limit       = max(1, min(int(request.args.get("limit", 10)), 30))
    only_trains = request.args.get("route_type") == "train"
    now         = int(time.time())

    with gtfs_store.lock:
        all_stops_data      = dict(gtfs_store.stops)
        routes              = dict(gtfs_store.routes)
        trips               = dict(gtfs_store.trips)
        trip_headsigns      = dict(gtfs_store.trip_headsigns)
        trip_origin_map     = dict(gtfs_store.trip_origin_map)
        rt_trip_short_names = dict(gtfs_store.rt_trip_short_names)
        static_stop_arrs    = dict(gtfs_store.static_stop_arrivals)

    with train_store.lock:
        tv_ann          = dict(train_store.announcements)
        tv_stations     = dict(train_store.stations)
        tv_positions_raw = list(train_store.positions)

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
        static_arrs.extend(static_stop_arrs.get(qid, []))

    dest_stop_names = {all_stops_data.get(qid, {}).get("stop_name", "") for qid in query_ids}
    dest_stop_names.add(target_stop.get("stop_name", ""))
    dest_stop_names.discard("")

    # GPS lookup by train number
    _pos_cutoff = now - 600
    pos_by_train: dict = {}
    for _p in tv_positions_raw:
        _tn = _p.get("train_number", "")
        if not _tn:
            continue
        _ts = _p.get("timestamp") or 0
        if _ts < _pos_cutoff:
            continue
        if _tn not in pos_by_train or _ts > (pos_by_train[_tn].get("timestamp") or 0):
            pos_by_train[_tn] = _p
    for _p in oxyfi.get_trains():
        _tn = _p.get("label", "")
        if _tn:
            pos_by_train[_tn] = _p

    _sta_lat       = config.TV_POSITION_CENTER_LAT
    _sta_lon       = config.TV_POSITION_CENTER_LON
    _cos_lat       = math.cos(math.radians(_sta_lat))
    _GPS_ARRIVED_M = 600

    def _gps_at_station(train_num):
        pos = pos_by_train.get(train_num)
        if not pos:
            return None
        dlat   = math.radians(pos["lat"] - _sta_lat)
        dlon   = math.radians(pos["lon"] - _sta_lon)
        dist_m = 6371000 * math.sqrt(dlat ** 2 + (_cos_lat * dlon) ** 2)
        return dist_m <= _GPS_ARRIVED_M

    upcoming_raw = sorted(
        [a for a in static_arrs if a["time"] >= now - 600],
        key=lambda a: a["time"],
    )
    seen_gtfs_times: set = set()
    upcoming = []
    for a in upcoming_raw:
        if a["time"] not in seen_gtfs_times:
            seen_gtfs_times.add(a["time"])
            upcoming.append(a)

    tib_agency = config.TIB_AGENCY_ID
    tib_routes = config.TIB_ROUTE_SHORT_NAMES
    loc_sig = config.TRAFIKVERKET_STATIONS.get(stop_id, "")
    if not loc_sig:
        for qid in query_ids:
            ls = config.TRAFIKVERKET_STATIONS.get(qid, "")
            if ls:
                loc_sig = ls
                break

    arrs = []
    used_tv_arr_keys: set = set()
    for a in upcoming:
        route_id = a["route_id"]
        trip_id  = a["trip_id"]
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

        headsign        = trip_headsigns.get(trip_id, "") or route.get("route_long_name", "")
        origin          = trip_origin_map.get(trip_id, "")
        trip_short_name = (
            trips.get(trip_id, {}).get("trip_short_name", "")
            or rt_trip_short_names.get(trip_id, "")
            or a.get("rt_trip_short_name", "")
        )
        rsn   = route.get("route_short_name", "?")
        color = config.ROUTE_COLOR_OVERRIDES.get(rsn) or route.get("route_color", "0074D9")

        tv_track = tv_canceled = tv_track_changed = tv_preliminary = False
        tv_deviation = tv_other_info = []
        tv_traffic_type = tv_arr_operator = tv_arr_product = ""
        tv_rt_arr_time = tv_arr_sched_override = None
        tv_track = ""

        if loc_sig and tv_ann.get(loc_sig):
            arr_time  = a.get("sched_time") or a["time"]
            tv_ops    = config.TRAFIKVERKET_OPERATORS
            best_tv   = None
            best_diff = float("inf")
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
                trip_short_name      = best_tv["train_number"]
                tv_arr_operator      = best_tv.get("operator", "")
                tv_arr_product       = best_tv.get("product", "")
                if not config.ROUTE_COLOR_OVERRIDES.get(rsn):
                    op_l, pr_l = tv_arr_operator.lower(), tv_arr_product.lower()
                    if "mälartåg" in op_l or "mälartåg" in pr_l:
                        color = "005B99"
                    elif "sj" in op_l:
                        color = "D4004C"
                    elif "arriva" in op_l or "bergslagen" in pr_l:
                        color = "E87722"
                tv_track              = best_tv["track"]
                tv_canceled           = best_tv["canceled"]
                tv_deviation          = best_tv["deviation"]
                tv_other_info         = best_tv.get("other_info", [])
                tv_preliminary        = best_tv.get("preliminary", False)
                tv_traffic_type       = best_tv.get("traffic_type", "")
                tv_rt_arr_time        = best_tv.get("realtime_time")
                tv_arr_sched_override = best_tv["scheduled_time"]
                tv_arr_track_changed  = any("spår" in t.lower() for t in tv_deviation)
                if best_tv["origin_sig"]:
                    origin = tv_stations.get(best_tv["origin_sig"], {}).get("name", best_tv["origin_sig"])

        if origin and origin in dest_stop_names:
            continue

        arr_sched_time = tv_arr_sched_override if tv_arr_sched_override else (a.get("sched_time") or a["time"])
        arrs.append({
            "route_short_name": rsn,
            "trip_short_name":  trip_short_name,
            "route_color":      color,
            "route_text_color": route.get("route_text_color", "FFFFFF"),
            "operator":         tv_arr_operator,
            "product":          tv_arr_product,
            "origin":           origin,
            "arrival_time":     tv_rt_arr_time if tv_rt_arr_time else arr_sched_time,
            "scheduled_time":   arr_sched_time,
            "is_realtime":      bool(tv_rt_arr_time),
            "trip_id":          trip_id,
            "platform":         tv_track,
            "track_changed":    tv_arr_track_changed if loc_sig else False,
            "canceled":         tv_canceled,
            "deviation":        tv_deviation,
            "other_info":       tv_other_info,
            "preliminary":      tv_preliminary,
            "traffic_type":     tv_traffic_type,
        })
        if len(arrs) >= limit:
            break

    # TV-only arrivals
    if only_trains and loc_sig and tv_ann.get(loc_sig):
        for tv_arr in tv_ann[loc_sig].get("arrivals", []):
            tv_key = (tv_arr["train_number"], tv_arr["scheduled_time"])
            if tv_key in used_tv_arr_keys:
                continue
            if tv_arr["scheduled_time"] < now - 300:
                continue
            origin_name = (
                tv_stations.get(tv_arr.get("origin_sig", ""), {}).get("name", "")
                if tv_arr.get("origin_sig") else ""
            )
            if origin_name and origin_name in dest_stop_names:
                continue
            op, pr = (tv_arr.get("operator") or "").lower(), (tv_arr.get("product") or "").lower()
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
            sched_t   = tv_arr["scheduled_time"]
            rt_t      = tv_arr.get("realtime_time")
            track_chg = any("spår" in t.lower() for t in tv_arr.get("deviation", []))
            arrs.append({
                "route_short_name": tv_rsn,
                "trip_short_name":  tv_arr["train_number"],
                "route_color":      tv_color,
                "route_text_color": "FFFFFF",
                "operator":         tv_arr.get("operator", ""),
                "product":          tv_arr.get("product", ""),
                "origin":           origin_name,
                "arrival_time":     rt_t if rt_t else sched_t,
                "scheduled_time":   sched_t,
                "is_realtime":      bool(rt_t),
                "trip_id":          "",
                "platform":         tv_arr.get("track", ""),
                "track_changed":    track_chg,
                "canceled":         tv_arr.get("canceled", False),
                "deviation":        tv_arr.get("deviation", []),
                "other_info":       tv_arr.get("other_info", []),
                "preliminary":      tv_arr.get("preliminary", False),
                "traffic_type":     tv_arr.get("traffic_type", ""),
            })
        arrs.sort(key=lambda x: x["arrival_time"])

    seen_arr: set = set()
    deduped_arrs = []
    for entry in arrs:
        key = (entry["scheduled_time"], entry["origin"])
        if key not in seen_arr:
            seen_arr.add(key)
            deduped_arrs.append(entry)
    arrs = deduped_arrs[:limit]

    for entry in arrs:
        entry["gps_at_station"] = _gps_at_station(entry.get("trip_short_name", ""))

    return jsonify({"stop_id": stop_id, "arrivals": arrs, "count": len(arrs)})


# ---------------------------------------------------------------------------
# /api/station-messages/<stop_id>
# ---------------------------------------------------------------------------

@bp.route("/api/station-messages/<stop_id>")
def station_messages(stop_id):
    """Return current Trafikverket TrainStationMessages for a stop."""
    with train_store.lock:
        tv_messages = dict(train_store.messages)
        tv_stations = dict(train_store.stations)

    loc_sig = config.TRAFIKVERKET_STATIONS.get(stop_id, "")
    if not loc_sig:
        with gtfs_store.lock:
            all_stops = dict(gtfs_store.stops)
        target = all_stops.get(stop_id, {})
        if target.get("location_type", 0) == 1:
            for child_id in [s["stop_id"] for s in all_stops.values()
                              if s.get("parent_station") == stop_id]:
                loc_sig = config.TRAFIKVERKET_STATIONS.get(child_id, "")
                if loc_sig:
                    break

    all_msgs = tv_messages.get(loc_sig, [])
    announcements     = [m for m in all_msgs if m.get("media_type") == "Utrop"]
    platform_messages: dict = {}
    for m in all_msgs:
        if m.get("media_type") == "Plattformsskylt":
            for track in m.get("tracks", []):
                platform_messages.setdefault(track, []).append({
                    "body":   m["body"],
                    "status": m.get("status", "Normal"),
                })

    return jsonify({
        "announcements":     announcements,
        "platform_messages": platform_messages,
        "station_name":      tv_stations.get(loc_sig, {}).get("name", "") if loc_sig else "",
    })
