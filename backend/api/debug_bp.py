"""Debug Blueprint — all /api/debug/* endpoints.

Protected by two independent layers:
  1. Nginx allow/deny rules (only LAN traffic reaches these URLs)
  2. @_debug_only decorator (returns 404 unless ENABLE_DEBUG_ENDPOINTS=true)
"""

from flask import Blueprint, jsonify, request

import config
import oxyfi
from store import _data, _lock, _debug_only
from train_logic import _tv_trains_from_positions

bp = Blueprint("debug", __name__)


@bp.route("/api/debug/status")
@_debug_only
def status_debug():
    """Internal status — full diagnostic info."""
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
            "map_center_lat": config.MAP_CENTER_LAT,
            "map_center_lon": config.MAP_CENTER_LON,
            "map_default_zoom": config.MAP_DEFAULT_ZOOM,
            "operator": config.OPERATOR,
            "has_static_key": bool(config.TRAFIKLAB_GTFS_STATIC_KEY),
            "has_rt_key": bool(config.TRAFIKLAB_GTFS_RT_KEY),
            "static_stops_with_departures": len(_data.get("static_stop_departures", {})),
            "has_tv_key": bool(config.TRAFIKVERKET_API_KEY),
            "tv_stations_configured": len(config.TRAFIKVERKET_STATIONS),
            "tv_announcements_loaded": len(_data.get("tv_announcements", {})),
            "tv_last_poll": _data.get("tv_last_poll", 0),
            "tv_last_error": _data.get("tv_last_error"),
        })


@bp.route("/api/debug/matching")
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


@bp.route("/api/debug/agencies")
@_debug_only
def debug_agencies():
    """Debug: list all agencies in the GTFS data with their agency_id."""
    with _lock:
        agencies = _data.get("agencies", {})
        routes = _data["routes"]

    agency_route_counts = {}
    for r in routes.values():
        aid = r.get("agency_id", "")
        agency_route_counts[aid] = agency_route_counts.get(aid, 0) + 1

    result = []
    for aid, ag in agencies.items():
        result.append({
            "agency_id": aid,
            "agency_name": ag.get("agency_name", ""),
            "route_count": agency_route_counts.get(aid, 0),
        })
    result.sort(key=lambda x: x["agency_name"])
    return jsonify({"agencies": result, "tib_agency_id_configured": config.TIB_AGENCY_ID})


@bp.route("/api/debug/stops-fields")
@_debug_only
def debug_stops_fields():
    """Debug: show coverage of platform_code / stop_desc / parent_station in GTFS stops.

    ?local=1  restricts sample to stops within Örebro county bounding box.
    """
    with _lock:
        stops = list(_data["stops"].values())

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

    platform_values = sorted(set(s["platform_code"] for s in has_platform))
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


@bp.route("/api/debug/routes")
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


@bp.route("/api/debug/trip-names")
@_debug_only
def debug_trip_names():
    """Debug: inspect trip_short_name values for train routes (sample of 5 per route)."""
    with _lock:
        all_routes = _data["routes"]
        trips = _data["trips"]

    train_route_ids = {
        rid for rid, r in all_routes.items()
        if r.get("route_type") == 2 or 100 <= (r.get("route_type") or 0) <= 199
    }

    by_route: dict = {}
    for trip in trips.values():
        rid = trip.get("route_id", "")
        if rid not in train_route_ids:
            continue
        rsn = all_routes.get(rid, {}).get("route_short_name", rid)
        entry = {
            "trip_id": trip["trip_id"],
            "trip_short_name": trip.get("trip_short_name", ""),
        }
        by_route.setdefault(rsn, [])
        if len(by_route[rsn]) < 5:
            by_route[rsn].append(entry)

    has_names = {rsn: any(e["trip_short_name"] for e in entries)
                 for rsn, entries in by_route.items()}
    with _lock:
        rt_names = _data.get("rt_trip_short_names", {})
    rt_sample = dict(list(rt_names.items())[:10])
    return jsonify({
        "by_route": by_route,
        "has_trip_short_name": has_names,
        "rt_trip_short_names_count": len(rt_names),
        "rt_sample": rt_sample,
    })


@bp.route("/api/debug/rt-feed")
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


@bp.route("/api/debug/tv-stations")
@_debug_only
def debug_tv_stations():
    """Show cached Trafikverket station lookup table."""
    with _lock:
        stations = dict(_data["tv_stations"])
    sample = dict(list(stations.items())[:20])
    return jsonify({
        "total_stations": len(stations),
        "sample": sample,
        "configured_mapping": config.TRAFIKVERKET_STATIONS,
        "api_key_set": bool(config.TRAFIKVERKET_API_KEY),
    })


@bp.route("/api/debug/tv-announcements")
@_debug_only
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


@bp.route("/api/debug/tv-match")
@_debug_only
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

    tv_results = []
    for sig, info in tv_stations.items():
        name = info.get("name", "")
        if q and q not in name.lower():
            continue
        tv_results.append({"sig": sig, "name": name, "lat": info.get("lat"), "lon": info.get("lon")})

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

    gtfs_results = []
    for stop_id, s in gtfs_stops.items():
        name = s.get("stop_name", "")
        if q and q not in name.lower():
            continue
        if s.get("location_type", 0) == 1:
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


@bp.route("/api/debug/trains")
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


@bp.route("/api/debug/tv-positions")
@_debug_only
def debug_tv_positions():
    """Show raw Trafikverket TrainPosition cache and geo-filtered trains within radius."""
    with _lock:
        raw_positions = list(_data.get("tv_positions", []))
        last_poll = _data.get("tv_last_poll", 0)
        last_error = _data.get("tv_last_error")
        sse_state = _data.get("tv_sse_state", "disconnected")

    filtered = _tv_trains_from_positions()

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
