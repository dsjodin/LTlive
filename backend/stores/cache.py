"""TTL-based response cache.

Extracted from store.py so providers and blueprints can import it
without pulling in the full shared-state module.
"""

import threading
import time


class TTLCache:
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


# Singleton used throughout the application.
api_cache = TTLCache()
