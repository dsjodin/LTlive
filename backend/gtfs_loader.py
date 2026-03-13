"""Load and parse GTFS static data (stops, routes, trips, shapes)."""

import csv
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

    print(f"Downloading GTFS static data from {config.OPERATOR}...")
    resp = requests.get(config.GTFS_STATIC_URL, timeout=120)
    resp.raise_for_status()

    with open(zip_path, "wb") as f:
        f.write(resp.content)

    with zipfile.ZipFile(zip_path, "r") as zf:
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
            "location_type": int(row.get("location_type", 0)),
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
