"""Flask backend for LTlive - Live bus tracking for Örebro."""

import os
import threading
import time

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
    "alerts": [],
    "last_vehicle_update": 0,
    "gtfs_loaded": False,
}
_lock = threading.Lock()


def init_gtfs_static():
    """Download and load GTFS static data."""
    try:
        if not os.path.exists(os.path.join(config.GTFS_DATA_DIR, "routes.txt")):
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

        print(f"GTFS loaded: {len(routes)} routes, {len(stops)} stops, "
              f"{len(trips)} trips, {len(shapes)} shapes")
    except Exception as e:
        print(f"Error loading GTFS static data: {e}")
        # Mark as loaded so the app still serves RT data
        with _lock:
            _data["gtfs_loaded"] = True


def refresh_gtfs_static():
    """Re-download GTFS static data (scheduled daily)."""
    try:
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

        print("GTFS static data refreshed.")
    except Exception as e:
        print(f"Error refreshing GTFS static data: {e}")


def poll_realtime():
    """Poll GTFS-RT vehicle positions."""
    vehicles = gtfs_rt.fetch_vehicle_positions()
    alerts = gtfs_rt.fetch_service_alerts()
    with _lock:
        _data["vehicles"] = vehicles
        _data["alerts"] = alerts
        _data["last_vehicle_update"] = int(time.time())


# --- API Routes ---

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "gtfs_loaded": _data["gtfs_loaded"]})


@app.route("/api/vehicles")
def vehicles():
    """Return current vehicle positions with route info."""
    with _lock:
        vehicles = _data["vehicles"]
        routes = _data["routes"]
        trips = _data["trips"]

    enriched = []
    for v in vehicles:
        route_info = {}
        trip_info = trips.get(v.get("trip_id", ""), {})
        route_id = v.get("route_id") or trip_info.get("route_id", "")
        if route_id:
            route_info = routes.get(route_id, {})

        enriched.append({
            **v,
            "route_id": route_id,
            "route_short_name": route_info.get("route_short_name", ""),
            "route_long_name": route_info.get("route_long_name", ""),
            "route_color": route_info.get("route_color", "0074D9"),
            "route_text_color": route_info.get("route_text_color", "FFFFFF"),
            "trip_headsign": trip_info.get("trip_headsign", ""),
        })

    return jsonify({
        "vehicles": enriched,
        "timestamp": _data["last_vehicle_update"],
        "count": len(enriched),
    })


@app.route("/api/routes")
def routes():
    """Return all routes."""
    with _lock:
        route_list = list(_data["routes"].values())
    # Filter to bus types (route_type 3 = bus, 700-799 = bus in extended types)
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
    # Return parent stations (location_type=1) and stops without parent
    stations = [s for s in stop_list if s["location_type"] in (0, 1)]
    return jsonify({"stops": stations, "count": len(stations)})


@app.route("/api/stops/stations")
def stations():
    """Return only parent stations (location_type=1)."""
    with _lock:
        stop_list = list(_data["stops"].values())
    stations = [s for s in stop_list if s["location_type"] == 1]
    return jsonify({"stops": stations, "count": len(stations)})


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

    # Find all shape_ids used by trips on this route
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
        routes = _data["routes"]
        trips = _data["trips"]
        all_shapes = _data["shapes"]
        vehicles = _data["vehicles"]

    route = routes.get(route_id)
    if not route:
        return jsonify({"error": "Route not found"}), 404

    # Get trips for this route
    route_trips = {tid: t for tid, t in trips.items() if t["route_id"] == route_id}

    # Get shapes
    shape_ids = set(t["shape_id"] for t in route_trips.values() if t["shape_id"])
    shapes = {sid: all_shapes[sid] for sid in shape_ids if sid in all_shapes}

    # Get active vehicles
    active = [v for v in vehicles
              if v.get("route_id") == route_id
              or trips.get(v.get("trip_id", ""), {}).get("route_id") == route_id]

    return jsonify({
        "route": route,
        "shapes": shapes,
        "active_vehicles": active,
        "trip_count": len(route_trips),
    })


# --- Startup ---

def start_background_tasks():
    """Initialize GTFS data and start polling."""
    # Load GTFS static in background thread
    threading.Thread(target=init_gtfs_static, daemon=True).start()

    # Schedule GTFS-RT polling
    scheduler = BackgroundScheduler()
    scheduler.add_job(poll_realtime, "interval", seconds=config.RT_POLL_SECONDS,
                      max_instances=1)
    scheduler.add_job(refresh_gtfs_static, "interval",
                      hours=config.GTFS_REFRESH_HOURS, max_instances=1)
    scheduler.start()

    # Initial RT poll
    threading.Thread(target=poll_realtime, daemon=True).start()


start_background_tasks()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
