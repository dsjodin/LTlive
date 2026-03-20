"""SSE client management and vehicle push task.

Owns:
  - The set of connected SSE clients (one queue per client)
  - Per-IP connection limiting
  - push_sse()            — broadcast an event to all connected clients
  - push_vehicle_update() — merge buses + trains and push to SSE every tick

Import push_sse() from here if you need to broadcast events from outside
this module (e.g., bus_provider pushes alert events).
"""

import json
import queue as _queue
import time

import oxyfi
from data.vehicle_store import vehicle_store
from enrichment import enrich_vehicles
from train_logic import (
    _annotate_oxyfi_from_announcements,
    _merge_trains,
    _tv_trains_from_positions,
)

# ---------------------------------------------------------------------------
# Client registry
# ---------------------------------------------------------------------------

import threading

_sse_clients: list = []
_sse_clients_lock = threading.Lock()

# Per-IP connection limit (DoS protection)
_sse_ip_counts: dict[str, int] = {}
_sse_ip_lock = threading.Lock()
MAX_SSE_PER_IP = 4


def push_sse(event_type: str, data) -> None:
    """Push a Server-Sent Event to all connected clients."""
    msg = f"event: {event_type}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
    dead = []
    with _sse_clients_lock:
        clients = list(_sse_clients)
    for q in clients:
        try:
            q.put_nowait(msg)
        except _queue.Full:
            dead.append(q)
    if dead:
        with _sse_clients_lock:
            for q in dead:
                try:
                    _sse_clients.remove(q)
                except ValueError:
                    pass


def register_client(q: _queue.Queue, ip: str) -> bool:
    """Register a new SSE client queue.  Returns False if IP limit exceeded."""
    with _sse_ip_lock:
        count = _sse_ip_counts.get(ip, 0)
        if count >= MAX_SSE_PER_IP:
            return False
        _sse_ip_counts[ip] = count + 1
    with _sse_clients_lock:
        _sse_clients.append(q)
    return True


def unregister_client(q: _queue.Queue, ip: str) -> None:
    """Remove a disconnected SSE client queue."""
    with _sse_clients_lock:
        try:
            _sse_clients.remove(q)
        except ValueError:
            pass
    with _sse_ip_lock:
        _sse_ip_counts[ip] = max(0, _sse_ip_counts.get(ip, 1) - 1)


# ---------------------------------------------------------------------------
# Vehicle push task (called by scheduler every RT_POLL_SECONDS)
# ---------------------------------------------------------------------------

_prev_vehicles: dict = {}  # vehicle_id -> vehicle dict, for delta computation


def push_vehicle_update() -> None:
    """Merge buses + trains and push full + delta SSE events.

    Each source is wrapped in its own try/except so a crash in one source
    (e.g. train merge bug, Oxyfi disconnect) never silences the other.
    Buses always stream even if trains are broken, and vice versa.

    Emits two SSE events per tick:
      - ``vehicles``       — full list (backward-compat with old clients)
      - ``vehicles_delta`` — only changed/removed vehicles (≈80–95% smaller)
    """
    global _prev_vehicles

    trains = []
    try:
        oxyfi_trains = oxyfi.get_trains()
        tv_trains    = _tv_trains_from_positions()
        trains       = _merge_trains(oxyfi_trains, tv_trains)
        trains       = _annotate_oxyfi_from_announcements(trains)
    except Exception as exc:
        print(f"[sse] train source error (buses will still push): {exc}")

    buses = []
    ts = int(time.time())
    try:
        with vehicle_store.lock:
            vehicle_list = list(vehicle_store.vehicles)
            ts           = vehicle_store.last_vehicle_update
        buses = enrich_vehicles(vehicle_list)
    except Exception as exc:
        print(f"[sse] bus source error: {exc}")

    combined = buses + trains
    push_sse("vehicles", {"vehicles": combined, "timestamp": ts, "count": len(combined)})

    # Delta event
    current: dict = {v["vehicle_id"]: v for v in combined if v.get("vehicle_id")}
    removed  = list(set(_prev_vehicles) - set(current))
    updated  = [
        v for vid, v in current.items()
        if vid not in _prev_vehicles or _prev_vehicles[vid] != v
    ]
    if updated or removed:
        push_sse("vehicles_delta", {
            "updated":   updated,
            "removed":   removed,
            "timestamp": ts,
        })
    _prev_vehicles = current
