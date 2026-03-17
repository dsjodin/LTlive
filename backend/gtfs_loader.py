"""Load and parse GTFS static data (stops, routes, trips, shapes)."""

import csv
import datetime
import io
import os
import zipfile
from collections import defaultdict

import requests

import config


def download_gtfs_static():
    """Download and extract GTFS static zip to data directory."""
    os.makedirs(config.GTFS_DATA_DIR, exist_ok=True)
    zip_path = os.path.join(config.GTFS_DATA_DIR, "gtfs.zip")

    # Mask key in log output
    safe_url = config.GTFS_STATIC_URL.split("?")[0]
    print(f"Downloading GTFS static data: {safe_url}")
    print(f"  Using static key: {'***' + config.TRAFIKLAB_GTFS_STATIC_KEY[-4:] if len(config.TRAFIKLAB_GTFS_STATIC_KEY) > 4 else '(empty or too short)'}")

    resp = requests.get(config.GTFS_STATIC_URL, timeout=120)

    # Check for HTTP errors with details
    if resp.status_code == 403:
        raise ValueError(
            f"403 Forbidden — API-nyckeln för GTFS Static är ogiltig eller saknas. "
            f"Kontrollera TRAFIKLAB_GTFS_STATIC_KEY i .env"
        )
    if resp.status_code == 429:
        raise ValueError("429 Too Many Requests — API-kvoten är överskriden")
    resp.raise_for_status()

    # Verify we got a zip file (not an HTML error page)
    content_type = resp.headers.get("content-type", "")
    if "html" in content_type or "text" in content_type:
        preview = resp.text[:300]
        raise ValueError(
            f"Fick HTML/text istället för zip-fil (content-type: {content_type}). "
            f"Svar: {preview}"
        )

    if len(resp.content) < 1000:
        raise ValueError(
            f"Svaret är för litet ({len(resp.content)} bytes) — "
            f"troligen inte en giltig GTFS-zip"
        )

    with open(zip_path, "wb") as f:
        f.write(resp.content)

    with zipfile.ZipFile(zip_path, "r") as zf:
        # Guard against zip path-traversal attacks before extracting
        safe_root = os.path.realpath(config.GTFS_DATA_DIR)
        for member in zf.namelist():
            dest = os.path.realpath(os.path.join(safe_root, member))
            if not dest.startswith(safe_root + os.sep) and dest != safe_root:
                raise ValueError(f"Unsafe path in GTFS zip: {member!r}")
        zf.extractall(config.GTFS_DATA_DIR)

    print(f"GTFS static data extracted to {config.GTFS_DATA_DIR}")


def _read_csv(filename):
    """Read a GTFS CSV file and return list of dicts."""
    filepath = os.path.join(config.GTFS_DATA_DIR, filename)
    if not os.path.exists(filepath):
        return []
    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return list(reader)


def load_routes():
    """Load routes.txt -> dict keyed by route_id."""
    routes = {}
    for row in _read_csv("routes.txt"):
        route_id = row["route_id"]
        routes[route_id] = {
            "route_id": route_id,
            "route_short_name": row.get("route_short_name", ""),
            "route_long_name": row.get("route_long_name", ""),
            "route_type": int(row.get("route_type", 3)),
            "route_color": row.get("route_color", "0074D9"),
            "route_text_color": row.get("route_text_color", "FFFFFF"),
        }
    return routes


def load_stops():
    """Load stops.txt -> dict keyed by stop_id."""
    stops = {}
    for row in _read_csv("stops.txt"):
        stop_id = row["stop_id"]
        lat = row.get("stop_lat", "")
        lon = row.get("stop_lon", "")
        if not lat or not lon:
            continue
        stops[stop_id] = {
            "stop_id": stop_id,
            "stop_name": row.get("stop_name", ""),
            "stop_lat": float(lat),
            "stop_lon": float(lon),
            "location_type": int(row.get("location_type", 0) or 0),
            "parent_station": row.get("parent_station", ""),
            "platform_code": row.get("platform_code", ""),
            "stop_desc": row.get("stop_desc", ""),
        }
    return stops


def load_trips():
    """Load trips.txt -> dict keyed by trip_id."""
    trips = {}
    for row in _read_csv("trips.txt"):
        trip_id = row["trip_id"]
        trips[trip_id] = {
            "trip_id": trip_id,
            "route_id": row.get("route_id", ""),
            "service_id": row.get("service_id", ""),
            "shape_id": row.get("shape_id", ""),
            "trip_headsign": row.get("trip_headsign", ""),
            "direction_id": row.get("direction_id", ""),
        }
    return trips


def load_shapes():
    """Load shapes.txt -> dict keyed by shape_id, value is list of [lat, lon]."""
    shapes = defaultdict(list)
    rows = _read_csv("shapes.txt")
    # Sort by shape_pt_sequence
    rows.sort(key=lambda r: int(r.get("shape_pt_sequence", 0)))
    for row in rows:
        shape_id = row["shape_id"]
        shapes[shape_id].append([
            float(row["shape_pt_lat"]),
            float(row["shape_pt_lon"]),
        ])
    return dict(shapes)


def load_stop_times_for_trips(trip_ids):
    """Load stop_times.txt, filtered to given trip_ids -> dict keyed by trip_id."""
    trip_stops = defaultdict(list)
    for row in _read_csv("stop_times.txt"):
        tid = row["trip_id"]
        if tid in trip_ids:
            trip_stops[tid].append({
                "stop_id": row["stop_id"],
                "stop_sequence": int(row.get("stop_sequence", 0)),
                "arrival_time": row.get("arrival_time", ""),
                "departure_time": row.get("departure_time", ""),
            })
    for tid in trip_stops:
        trip_stops[tid].sort(key=lambda x: x["stop_sequence"])
    return dict(trip_stops)


_GTFS_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _active_service_ids_today():
    """Return the set of service_ids active for today from calendar + calendar_dates."""
    today = datetime.date.today()
    today_str = today.strftime("%Y%m%d")
    weekday = _GTFS_WEEKDAYS[today.weekday()]  # locale-independent, matches GTFS column names

    active = set()
    for row in _read_csv("calendar.txt"):
        if row.get("start_date", "") <= today_str <= row.get("end_date", ""):
            if row.get(weekday, "0") == "1":
                active.add(row["service_id"])

    for row in _read_csv("calendar_dates.txt"):
        if row.get("date") == today_str:
            sid = row["service_id"]
            if row.get("exception_type") == "1":
                active.add(sid)
            elif row.get("exception_type") == "2":
                active.discard(sid)

    return active


def load_trip_headsigns_and_stop_route_map(stops, trips):
    """Build trip headsigns, stop->route mapping and today's static departures/arrivals.

    Does a single pass over stop_times.txt.

    Returns:
        headsigns: dict trip_id -> headsign (last stop name)
        stop_route_map: dict stop_id -> list of route_ids that serve the stop
        static_stop_departures: dict stop_id -> list of departure dicts for today
        static_stop_arrivals: dict stop_id -> list of arrival dicts for today
        trip_origin_map: dict trip_id -> origin stop_name (first stop of trip)
    """
    active_services = _active_service_ids_today()

    # Map trip_id -> route_id, and which trips are active today
    trip_to_route = {}
    active_trip_ids = set()
    for tid, t in trips.items():
        rid = t.get("route_id", "")
        if rid:
            trip_to_route[tid] = rid
        if t.get("service_id", "") in active_services:
            active_trip_ids.add(tid)

    today = datetime.date.today()
    today_midnight = int(datetime.datetime.combine(today, datetime.time.min).timestamp())

    trip_last_stop = {}   # trip_id -> (max_sequence, stop_id)
    trip_first_stop = {}  # trip_id -> (min_sequence, stop_id)
    stop_routes = defaultdict(set)
    static_departures = defaultdict(list)  # stop_id -> [dep, ...]
    static_arrivals = defaultdict(list)    # stop_id -> [arr, ...]

    for row in _read_csv("stop_times.txt"):
        tid = row["trip_id"]
        seq = int(row.get("stop_sequence", 0))
        stop_id = row["stop_id"]

        if tid not in trip_last_stop or seq > trip_last_stop[tid][0]:
            trip_last_stop[tid] = (seq, stop_id)
        if tid not in trip_first_stop or seq < trip_first_stop[tid][0]:
            trip_first_stop[tid] = (seq, stop_id)

        if tid in trip_to_route:
            stop_routes[stop_id].add(trip_to_route[tid])

        if tid in active_trip_ids:
            dep_str = row.get("departure_time", "") or row.get("arrival_time", "")
            if dep_str:
                parts = dep_str.split(":")
                if len(parts) == 3:
                    try:
                        h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
                        t = today_midnight + h * 3600 + m * 60 + s
                        static_departures[stop_id].append({
                            "trip_id": tid,
                            "route_id": trip_to_route.get(tid, ""),
                            "time": t,
                            "is_realtime": False,
                        })
                    except ValueError:
                        pass

            arr_str = row.get("arrival_time", "") or row.get("departure_time", "")
            if arr_str:
                parts = arr_str.split(":")
                if len(parts) == 3:
                    try:
                        h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
                        t = today_midnight + h * 3600 + m * 60 + s
                        static_arrivals[stop_id].append({
                            "trip_id": tid,
                            "route_id": trip_to_route.get(tid, ""),
                            "time": t,
                            "is_realtime": False,
                        })
                    except ValueError:
                        pass

    headsigns = {}
    for tid, (_, stop_id) in trip_last_stop.items():
        stop = stops.get(stop_id, {})
        name = stop.get("stop_name", "")
        if name:
            headsigns[tid] = name

    trip_origin_map = {}
    for tid, (_, stop_id) in trip_first_stop.items():
        stop = stops.get(stop_id, {})
        name = stop.get("stop_name", "")
        if name:
            trip_origin_map[tid] = name

    stop_route_map = {sid: list(rids) for sid, rids in stop_routes.items()}
    return headsigns, stop_route_map, dict(static_departures), dict(static_arrivals), trip_origin_map
