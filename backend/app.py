"""Flask backend for LTlive - Live bus tracking for Örebro."""

import os
import threading
import time
import traceback

from apscheduler.schedulers.background import BackgroundScheduler
from flask import Flask, jsonify
from flask_cors import CORS

import config
import gtfs_loader
import gtfs_rt

app = Flask(__name__)
CORS(app)

# In-memory data store
_data = {
    "routes": {},
    "stops": {},
    "trips": {},
    "shapes": {},
    "vehicles": [],
    "vehicle_trips": {},
    "alerts": [],
    "last_vehicle_update": 0,
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

        with _lock:
            _data["routes"] = routes
            _data["stops"] = stops
            _data["trips"] = trips
            _data["shapes"] = shapes
            _data["gtfs_loaded"] = True
            _data["gtfs_error"] = None

        print(f"GTFS loaded: {len(routes)} routes, {len(stops)} stops, "
              f"{len(trips)} trips, {len(shapes)} shapes")
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
    vehicles = gtfs_rt.fetch_vehicle_positions()
    vehicle_trips = gtfs_rt.fetch_trip_updates()
    alerts = gtfs_rt.fetch_service_alerts()

    # Merge TripUpdates data into vehicles that lack trip info
    if vehicle_trips:
        for v in vehicles:
            if not v.get("trip_id") and not v.get("route_id"):
                vid = v.get("vehicle_id", "")
                trip_info = vehicle_trips.get(vid, {})
                if trip_info:
                    v["trip_id"] = trip_info.get("trip_id", "")
                    v["route_id"] = trip_info.get("route_id", "")
                    v["direction_id"] = trip_info.get("direction_id")
                    v["start_date"] = trip_info.get("start_date", "")

    with _lock:
        _data["vehicles"] = vehicles
        _data["vehicle_trips"] = vehicle_trips
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
            "operator": config.OPERATOR,
            "has_static_key": bool(config.TRAFIKLAB_GTFS_STATIC_KEY),
            "has_rt_key": bool(config.TRAFIKLAB_GTFS_RT_KEY),
        })


@app.route("/api/debug/vehicle/<vehicle_id>")
def debug_vehicle(vehicle_id):
    """Debug: show raw data for a specific vehicle."""
    with _lock:
        vehicle_list = list(_data["vehicles"])
        routes = _data["routes"]
        trips = _data["trips"]
        vehicle_trips = _data.get("vehicle_trips", {})

    for v in vehicle_list:
        vid = v.get("vehicle_id") or v.get("id")
        if vid == vehicle_id:
            trip_id = v.get("trip_id", "")
            trip_info = trips.get(trip_id, {})
            route_id = v.get("route_id") or trip_info.get("route_id", "")
            route_info = routes.get(route_id, {})
            trip_update_info = vehicle_trips.get(vid, {})
            return jsonify({
                "raw_vehicle": v,
                "trip_id_from_rt": trip_id,
                "trip_found_in_static": bool(trip_info),
                "trip_info": trip_info,
                "route_info": route_info,
                "trip_update_mapping": trip_update_info,
                "sample_trip_keys": list(trips.keys())[:5],
                "sample_vehicle_trip_keys": list(vehicle_trips.keys())[:5],
                "total_vehicle_trip_mappings": len(vehicle_trips),
            })
    return jsonify({"error": f"Vehicle {vehicle_id} not found"}), 404


@app.route("/api/vehicles")
def vehicles():
    """Return current vehicle positions with route info."""
    with _lock:
        vehicle_list = list(_data["vehicles"])
        routes = _data["routes"]
        trips = _data["trips"]
        stops = _data["stops"]

    enriched = []
    for v in vehicle_list:
        route_info = {}
        trip_info = trips.get(v.get("trip_id", ""), {})
        route_id = v.get("route_id") or trip_info.get("route_id", "")
        if route_id:
            route_info = routes.get(route_id, {})

        # Build headsign with fallbacks
        headsign = trip_info.get("trip_headsign", "")
        if not headsign:
            # Fallback: use route_long_name (often "A - B" format)
            headsign = route_info.get("route_long_name", "")

        enriched.append({
            **v,
            "route_id": route_id,
            "route_short_name": route_info.get("route_short_name", ""),
            "route_long_name": route_info.get("route_long_name", ""),
            "route_color": route_info.get("route_color", "0074D9"),
            "route_text_color": route_info.get("route_text_color", "FFFFFF"),
            "trip_headsign": headsign,
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
    """Return all stops (location_type 0 = stop, 1 = station)."""
    with _lock:
        stop_list = list(_data["stops"].values())
    return jsonify({"stops": stop_list, "count": len(stop_list)})


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
