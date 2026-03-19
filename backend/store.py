"""Shared application state.

Imported by app.py and Blueprint modules to access the in-memory data
store, cache, and the debug-endpoint decorator without circular imports.

    from store import _data, _lock, _api_cache, _cache_get, _cache_set
    from store import _invalidate_cache, _debug_only
"""

import os
import threading
import time
from functools import wraps

# ---------------------------------------------------------------------------
# Debug endpoint flag
# ---------------------------------------------------------------------------

_DEBUG_ENDPOINTS = os.environ.get("ENABLE_DEBUG_ENDPOINTS", "false").lower() in ("true", "1", "yes")


def _debug_only(f):
    """Decorator: return 404 unless ENABLE_DEBUG_ENDPOINTS=true."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not _DEBUG_ENDPOINTS:
            from flask import jsonify
            return jsonify({"error": "Not found"}), 404
        return f(*args, **kwargs)
    return wrapper


# ---------------------------------------------------------------------------
# In-memory data store
# ---------------------------------------------------------------------------

_data: dict = {
    "routes": {},
    "stops": {},
    "trips": {},
    "shapes": {},
    "vehicles": [],
    "vehicle_trips": {},
    "vehicle_next_stop": {},
    "alerts": [],
    "trip_headsigns": {},
    "last_vehicle_update": 0,
    "last_rt_poll": 0,
    "last_rt_poll_count": None,
    "last_rt_error": None,
    "gtfs_loaded": False,
    "gtfs_error": None,
    "static_stop_departures": {},
    "static_stop_arrivals": {},
    "trip_origin_map": {},
    "rt_trip_short_names": {},
    # Trafikverket data
    "tv_announcements": {},   # {location_sig: {departures: [...], arrivals: [...]}}
    "tv_stations": {},        # {location_sig: {name, lat, lon}}
    "tv_positions": [],       # list of {train_number, lat, lon, bearing, ...}
    "tv_messages": {},        # {location_sig: [{header, body, start, end}]}
    "tv_last_poll": 0,
    "tv_last_error": None,
    "tv_sse_state": "disconnected",  # "connected" | "reconnecting" | "disconnected"
}

_lock = threading.Lock()


# ---------------------------------------------------------------------------
# TTL-based response cache
# ---------------------------------------------------------------------------

class _TTLCache:
    """Per-key TTL cache with selective prefix invalidation.

    Keys:
      "vehicles"                           -> 4s  TTL
      "next_dep"                           -> 30s TTL
      ("dep", stop_id, limit, trains_only) -> 10s TTL
    """
    _TTL = {"vehicles": 4, "next_dep": 30, "dep": 10}

    def __init__(self):
        self._store: dict = {}
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            entry = self._store.get(key)
        if entry is None:
            return None
        payload, expires_at = entry
        if time.time() > expires_at:
            with self._lock:
                self._store.pop(key, None)
            return None
        return payload

    def set(self, key, payload, ttl: int | None = None):
        if ttl is None:
            key_type = key if isinstance(key, str) else key[0]
            ttl = self._TTL.get(key_type, 10)
        with self._lock:
            self._store[key] = (payload, time.time() + ttl)

    def invalidate(self, *keys):
        with self._lock:
            for k in keys:
                self._store.pop(k, None)

    def invalidate_prefix(self, prefix: str):
        """Invalidate all keys whose type (string or first tuple element) matches prefix."""
        with self._lock:
            to_del = [k for k in self._store
                      if (k[0] if isinstance(k, tuple) else k) == prefix]
            for k in to_del:
                del self._store[k]

    def clear(self):
        with self._lock:
            self._store.clear()


_api_cache = _TTLCache()


def _cache_get(key):
    return _api_cache.get(key)


def _cache_set(key, payload):
    _api_cache.set(key, payload)


def _invalidate_cache():
    """Full cache wipe — use only on GTFS static refresh. Prefer selective invalidation."""
    _api_cache.clear()
