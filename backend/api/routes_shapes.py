"""Routes and shapes Blueprint — /api/routes* and /api/shapes* endpoints.

All endpoints here are pure reads of GTFS static data with no side effects.
"""

from flask import Blueprint, jsonify, request

from store import _data, _lock

bp = Blueprint("routes_shapes", __name__)

# Supplementary track shapes not present in GTFS static data.
# Coordinates from OpenStreetMap (Västra Stambanan: Hallsberg – Pålsboda).
_EXTRA_TRAIN_SHAPES = {
    "extra_hallsberg_palsboda": [
        [59.0647, 15.0969], [59.0654, 15.1012], [59.0661, 15.1054],
        [59.0669, 15.1102], [59.0679, 15.1163], [59.0685, 15.1206],
        [59.0686, 15.1222], [59.0691, 15.1270], [59.0699, 15.1348],
        [59.0715, 15.1509], [59.0724, 15.1602], [59.0728, 15.1644],
        [59.0732, 15.1676], [59.0736, 15.1702], [59.0748, 15.1768],
        [59.0757, 15.1815], [59.0760, 15.1839], [59.0764, 15.1865],
        [59.0766, 15.1884], [59.0767, 15.1904], [59.0768, 15.1948],
        [59.0769, 15.2014], [59.0769, 15.2080], [59.0770, 15.2097],
        [59.0769, 15.2122], [59.0768, 15.2151], [59.0766, 15.2166],
        [59.0762, 15.2201], [59.0749, 15.2347], [59.0747, 15.2366],
        [59.0746, 15.2379], [59.0746, 15.2401], [59.0745, 15.2416],
        [59.0745, 15.2441], [59.0747, 15.2456], [59.0750, 15.2480],
        [59.0753, 15.2509], [59.0755, 15.2536], [59.0755, 15.2561],
        [59.0755, 15.2577], [59.0754, 15.2600], [59.0751, 15.2617],
        [59.0749, 15.2634], [59.0745, 15.2651], [59.0739, 15.2669],
        [59.0733, 15.2679], [59.0725, 15.2706], [59.0703, 15.2775],
        [59.0696, 15.2795], [59.0691, 15.2815], [59.0687, 15.2834],
        [59.0683, 15.2854], [59.0679, 15.2881], [59.0675, 15.2903],
        [59.0659, 15.3028], [59.0649, 15.3108], [59.0646, 15.3129],
        [59.0644, 15.3145], [59.0643, 15.3160], [59.0642, 15.3175],
        [59.0641, 15.3198], [59.0641, 15.3245], [59.0640, 15.3266],
        [59.0640, 15.3328], [59.0639, 15.3372], [59.0638, 15.3478],
        [59.0638, 15.3530], [59.0637, 15.3545], [59.0636, 15.3675],
        [59.0636, 15.3719], [59.0636, 15.3748], [59.0635, 15.3842],
        [59.0634, 15.3870], [59.0635, 15.3894], [59.0644, 15.4067],
        [59.0653, 15.4240], [59.0658, 15.4339], [59.0662, 15.4415],
        [59.0671, 15.4587], [59.0672, 15.4620], [59.0672, 15.4643],
        [59.0672, 15.4716], [59.0672, 15.4775], [59.0671, 15.4934],
        [59.0671, 15.5014], [59.0670, 15.5107], [59.0670, 15.5212],
        [59.0669, 15.5237], [59.0668, 15.5263], [59.0666, 15.5284],
        [59.0663, 15.5308], [59.0656, 15.5367], [59.0652, 15.5408],
        [59.0649, 15.5434], [59.0648, 15.5454], [59.0647, 15.5472],
        [59.0647, 15.5492], [59.0645, 15.5628], [59.0644, 15.5668],
        [59.0642, 15.5801], [59.0640, 15.5975], [59.0637, 15.6150],
        [59.0636, 15.6238], [59.0635, 15.6324], [59.0634, 15.6392],
        [59.0633, 15.6414], [59.0631, 15.6437], [59.0629, 15.6454],
        [59.0626, 15.6475], [59.0622, 15.6495], [59.0618, 15.6516],
        [59.0613, 15.6531], [59.0585, 15.6633], [59.0580, 15.6649],
        [59.0544, 15.6779], [59.0540, 15.6795], [59.0535, 15.6818],
        [59.0533, 15.6835], [59.0531, 15.6852], [59.0530, 15.6868],
        [59.0529, 15.6891], [59.0525, 15.6949], [59.0524, 15.6968],
        [59.0515, 15.7074], [59.0508, 15.7145], [59.0501, 15.7227],
        [59.0493, 15.7318], [59.0478, 15.7488], [59.0474, 15.7533],
        [59.0473, 15.7550], [59.0472, 15.7567], [59.0471, 15.7591],
        [59.0471, 15.7611], [59.0470, 15.7661], [59.0470, 15.7720],
        [59.0470, 15.7835], [59.0469, 15.8009], [59.0469, 15.8073],
        [59.0468, 15.8087], [59.0468, 15.8102], [59.0468, 15.8115],
        [59.0467, 15.8125], [59.0466, 15.8141],
    ],
}


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

    # Append supplementary track shapes not in GTFS
    for sid, coords in _EXTRA_TRAIN_SHAPES.items():
        if sid not in shapes_out:
            shapes_out[sid] = coords

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
