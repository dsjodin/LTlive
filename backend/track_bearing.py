"""Track direction lookup from Trafikverket BanInfo (WMS GetFeatureInfo).

Used for stationary trains whose GPS reports no bearing. get() never blocks:
a miss queues a background lookup and returns None; the result is cached per
~10 m grid cell, so the next push tick has it.
"""
import logging
import math
import queue
import threading

import requests

log = logging.getLogger(__name__)

_URL = "https://geo-baninfo.trafikverket.se/MapService/wms.axd/BanInfo_1_5"
_HALF_M = 25  # search box half-size around the train, metres
_PX = 51

_cache: dict = {}
_pending: set = set()
_lock = threading.Lock()
_queue: queue.Queue = queue.Queue()
_worker_started = False


def _key(lat: float, lon: float) -> tuple:
    return (round(lat, 4), round(lon, 4))


def get(lat: float, lon: float) -> float | None:
    """Return the cached track bearing near (lat, lon), or None (and queue a lookup)."""
    global _worker_started
    k = _key(lat, lon)
    with _lock:
        if k in _cache:
            return _cache[k]
        if k not in _pending:
            _pending.add(k)
            _queue.put(k)
        if not _worker_started:
            _worker_started = True
            threading.Thread(target=_worker, daemon=True, name="track-bearing").start()
    return None


def _merc(lat: float, lon: float) -> tuple:
    return (lon * 20037508.34 / 180,
            math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * 6378137)


def _lookup(lat: float, lon: float) -> float | None:
    x, y = _merc(lat, lon)
    resp = requests.get(_URL, params={
        "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetFeatureInfo",
        "CRS": "EPSG:3857", "STYLES": "", "FORMAT": "image/png",
        "LAYERS": "Spar_Huvud_och_sidospar", "QUERY_LAYERS": "Spar_Huvud_och_sidospar",
        "INFO_FORMAT": "application/json", "FEATURE_COUNT": 10,
        "BBOX": f"{x - _HALF_M},{y - _HALF_M},{x + _HALF_M},{y + _HALF_M}",
        "WIDTH": _PX, "HEIGHT": _PX, "I": _PX // 2, "J": _PX // 2,
    }, timeout=20)
    resp.raise_for_status()

    best_d, best_b = float("inf"), None
    for f in resp.json().get("features", []):
        geom = f.get("geometry") or {}
        lines = geom.get("coordinates") or []
        if geom.get("type") == "LineString":
            lines = [lines]
        for line in lines:
            for (ax, ay), (bx, by) in zip(line, line[1:]):
                dx, dy = bx - ax, by - ay
                len2 = dx * dx + dy * dy
                if not len2:
                    continue
                t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / len2))
                d = math.hypot(x - (ax + t * dx), y - (ay + t * dy))
                if d < best_d:
                    # Web Mercator is conformal: angle from north, clockwise
                    best_d, best_b = d, math.degrees(math.atan2(dx, dy)) % 360
    return best_b


def _worker() -> None:
    while True:
        k = _queue.get()
        try:
            bearing = _lookup(*k)
            with _lock:
                if len(_cache) > 5000:
                    _cache.clear()
                _cache[k] = bearing
        except Exception as exc:
            log.warning("track bearing lookup failed: %s", exc)
        finally:
            with _lock:
                _pending.discard(k)
