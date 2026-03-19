"""Routes and shapes Blueprint — /api/routes* and /api/shapes* endpoints.

All endpoints here are pure reads of GTFS static data with no side effects.
"""

from flask import Blueprint, jsonify, request

from store import _data, _lock

bp = Blueprint("routes_shapes", __name__)


@bp.route("/api/routes")
def routes_bus():
    """Return bus routes only."""
    with _lock:
        route_list = list(_data["routes"].values())
    bus_routes = [r for r in route_list
                  if r["route_type"] == 3 or 700 <= r["route_type"] <= 799]
    return jsonify({"routes": bus_routes, "count": len(bus_routes)})


@bp.route("/api/routes/trains")
def routes_trains():
    """Return train routes only (GTFS route_type 2 = rail, or 100–199)."""
    with _lock:
        route_list = list(_data["routes"].values())
    train_routes = [r for r in route_list
                    if r["route_type"] == 2 or 100 <= r["route_type"] <= 199]
    return jsonify({"routes": train_routes, "count": len(train_routes)})


@bp.route("/api/routes/all")
def routes_all():
    """Return all routes regardless of type."""
    with _lock:
        route_list = list(_data["routes"].values())
    return jsonify({"routes": route_list, "count": len(route_list)})


@bp.route("/api/shapes/trains")
def train_shapes():
    """Return one representative rail shape per (route_id, direction_id).

    Picks the shape with the most points for each direction so we get
    the most-detailed geometry without drawing hundreds of near-identical
    trip shapes or degenerate 2-point straight-line shapes.
    Max shapes returned = 2 × number of train routes.
    """
    with _lock:
        trips = _data["trips"]
        routes = _data["routes"]
        all_shapes = _data["shapes"]

    train_route_ids = {rid for rid, r in routes.items()
                       if r["route_type"] == 2 or 100 <= r["route_type"] <= 199}

    best: dict = {}
    for trip in trips.values():
        rid = trip.get("route_id", "")
        if rid not in train_route_ids:
            continue
        sid = trip.get("shape_id", "")
        if not sid or sid not in all_shapes:
            continue
        pts = len(all_shapes[sid])
        key = (rid, trip.get("direction_id", 0))
        if key not in best or pts > best[key][1]:
            best[key] = (sid, pts)

    seen: set = set()
    shapes_out: dict = {}
    for sid, _ in best.values():
        if sid not in seen:
            seen.add(sid)
            shapes_out[sid] = all_shapes[sid]

    return jsonify({"shapes": shapes_out, "count": len(shapes_out)})


@bp.route("/api/shapes")
def shapes():
    """Return all shapes (route geometries)."""
    with _lock:
        all_shapes = _data["shapes"]
    return jsonify({"shapes": all_shapes, "count": len(all_shapes)})


@bp.route("/api/shapes/bulk")
def shapes_bulk():
    """Return shapes for multiple routes in one request (avoids burst of parallel HTTP calls)."""
    route_ids_param = request.args.get("route_ids", "")[:2000]
    if not route_ids_param:
        return jsonify({"routes": {}, "count": 0})

    requested = {r.strip() for r in route_ids_param.split(",") if r.strip()}

    with _lock:
        trips = _data["trips"]
        all_shapes = _data["shapes"]

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


@bp.route("/api/shapes/<route_id>")
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
