"""Shared application state — backward-compatibility shim.

New code should import typed store objects directly:

    from data.gtfs_store import gtfs_store
    from data.vehicle_store import vehicle_store
    from data.train_store import train_store
    from data.cache import api_cache

Existing blueprint code continues to use the legacy API:

    from store import _data, _lock, _api_cache, _cache_get, _cache_set
    from store import _invalidate_cache, _debug_only
"""

import os
import threading
from functools import wraps

from data.cache import TTLCache, api_cache
from data.gtfs_store import gtfs_store
from data.vehicle_store import vehicle_store
from data.train_store import train_store


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
# _DataView – dict-like proxy over the three typed stores
#
# Allows existing blueprint/app.py code to keep using _data["routes"] etc.
# while new providers/tasks write to the typed store objects directly.
# ---------------------------------------------------------------------------

class _DataView:
    """Read/write proxy that routes _data[key] to the correct store object."""

    # Maps legacy _data key -> (store_singleton, attribute_name)
    _MAP: dict = {
        # GTFS store
        "routes":                  (gtfs_store,    "routes"),
        "stops":                   (gtfs_store,    "stops"),
        "trips":                   (gtfs_store,    "trips"),
        "shapes":                  (gtfs_store,    "shapes"),
        "trip_headsigns":          (gtfs_store,    "trip_headsigns"),
        "stop_route_map":          (gtfs_store,    "stop_route_map"),
        "static_stop_departures":  (gtfs_store,    "static_stop_departures"),
        "static_stop_arrivals":    (gtfs_store,    "static_stop_arrivals"),
        "trip_origin_map":         (gtfs_store,    "trip_origin_map"),
        "rt_trip_short_names":     (gtfs_store,    "rt_trip_short_names"),
        "gtfs_loaded":             (gtfs_store,    "loaded"),
        "gtfs_error":              (gtfs_store,    "error"),
        # Vehicle store
        "vehicles":                (vehicle_store, "vehicles"),
        "vehicle_trips":           (vehicle_store, "vehicle_trips"),
        "vehicle_next_stop":       (vehicle_store, "vehicle_next_stop"),
        "stop_departures":         (vehicle_store, "stop_departures"),
        "alerts":                  (vehicle_store, "alerts"),
        "last_vehicle_update":     (vehicle_store, "last_vehicle_update"),
        "last_rt_poll":            (vehicle_store, "last_rt_poll"),
        "last_rt_poll_count":      (vehicle_store, "last_rt_poll_count"),
        "last_rt_error":           (vehicle_store, "last_rt_error"),
        # Train store
        "tv_announcements":        (train_store,   "announcements"),
        "tv_stations":             (train_store,   "stations"),
        "tv_positions":            (train_store,   "positions"),
        "tv_messages":             (train_store,   "messages"),
        "tv_last_poll":            (train_store,   "last_poll"),
        "tv_last_error":           (train_store,   "last_error"),
        "tv_sse_state":            (train_store,   "sse_state"),
    }

    def __getitem__(self, key: str):
        try:
            store, attr = self._MAP[key]
        except KeyError:
            raise KeyError(f"Unknown _data key: {key!r}")
        return getattr(store, attr)

    def __setitem__(self, key: str, value):
        try:
            store, attr = self._MAP[key]
        except KeyError:
            raise KeyError(f"Unknown _data key: {key!r}")
        setattr(store, attr, value)

    def get(self, key: str, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def __contains__(self, key: str) -> bool:
        return key in self._MAP


# Singleton proxy (backward compat)
_data = _DataView()

# Global lock kept for backward compat with existing blueprint code that does
#   with _lock: ... _data[key] ...
# New code should use the per-store locks (gtfs_store.lock, etc.) for finer
# granularity and to avoid bus/train polling blocking each other.
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# TTL cache — backward-compat wrappers around data/cache.py
# ---------------------------------------------------------------------------

_api_cache = api_cache


def _cache_get(key):
    return api_cache.get(key)


def _cache_set(key, payload):
    api_cache.set(key, payload)


def _invalidate_cache():
    """Full cache wipe — use only on GTFS static refresh."""
    api_cache.clear()
