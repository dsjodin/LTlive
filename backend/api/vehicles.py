"""Vehicles Blueprint — /api/vehicles and /api/stream endpoints."""

import json
import queue as _queue

from flask import Blueprint, Response, jsonify, request, stream_with_context

import oxyfi
from stores.vehicle_store import vehicle_store
from enrichment import enrich_vehicles
from store import _cache_get, _cache_set, _lock, _data
from tasks.sse_tasks import (
    MAX_SSE_PER_IP,
    push_sse,
    register_client,
    unregister_client,
)
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

    with vehicle_store.lock:
        vehicle_list = list(vehicle_store.vehicles)
        ts = vehicle_store.last_vehicle_update

    trains = _merge_trains(oxyfi.get_trains(), _tv_trains_from_positions())
    trains = _annotate_oxyfi_from_announcements(trains)
    enriched = enrich_vehicles(vehicle_list) + trains
    result = {"vehicles": enriched, "timestamp": ts, "count": len(enriched)}
    _cache_set("vehicles", result)
    return jsonify(result)


@bp.route("/api/stream")
def sse_stream():
    """Server-Sent Events stream: pushes vehicle and alert updates in real time."""
    client_ip = (
        request.headers.get("X-Forwarded-For", request.remote_addr or "")
        .split(",")[0]
        .strip() or "unknown"
    )

    q = _queue.Queue(maxsize=20)
    if not register_client(q, client_ip):
        return jsonify({"error": "Too many SSE connections from this IP"}), 429

    def generate():
        try:
            # Send current state immediately on connect
            with vehicle_store.lock:
                vehicle_list = list(vehicle_store.vehicles)
                ts           = vehicle_store.last_vehicle_update
            with _lock:
                alerts_list = list(_data["alerts"])
            enriched = enrich_vehicles(vehicle_list)
            yield (
                f"event: vehicles\ndata: "
                f"{json.dumps({'vehicles': enriched, 'timestamp': ts, 'count': len(enriched)}, separators=(',', ':'))}"
                f"\n\n"
            )
            if alerts_list:
                yield (
                    f"event: alerts\ndata: "
                    f"{json.dumps({'alerts': alerts_list, 'count': len(alerts_list)}, separators=(',', ':'))}"
                    f"\n\n"
                )
            while True:
                try:
                    msg = q.get(timeout=25)
                    yield msg
                except _queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            unregister_client(q, client_ip)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
