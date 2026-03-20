"""Vehicles Blueprint — /api/vehicles endpoint.

Moved from app.py to separate the vehicle data pipeline from SSE,
stats and other concerns.
"""

from flask import Blueprint, jsonify

import oxyfi
from enrichment import enrich_vehicles
from store import _data, _lock, _cache_get, _cache_set
from train_logic import (
    _annotate_oxyfi_from_announcements,
    _merge_trains,
    _tv_trains_from_positions,
)

bp = Blueprint("vehicles", __name__)


@bp.route("/api/vehicles")
def vehicles():
    """Return current vehicle positions with route info (buses + trains)."""
    cached = _cache_get("vehicles")
    if cached:
        return jsonify(cached)

    with _lock:
        vehicle_list = list(_data["vehicles"])
        ts = _data["last_vehicle_update"]

    trains = _merge_trains(oxyfi.get_trains(), _tv_trains_from_positions())
    trains = _annotate_oxyfi_from_announcements(trains)
    enriched = enrich_vehicles(vehicle_list) + trains
    result = {"vehicles": enriched, "timestamp": ts, "count": len(enriched)}
    _cache_set("vehicles", result)
    return jsonify(result)
