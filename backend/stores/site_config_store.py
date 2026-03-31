"""Site configuration store.

Centralised, persistent configuration for everything that used to live in
.env defaults + frontend/config.js hardcoded values.  Stored as a single
JSON file on disk so it survives container restarts and can be edited via
the admin UI.

Hierarchy (highest priority first):
    admin config (JSON file)  >  environment variables  >  hardcoded defaults

Usage:
    from stores.site_config_store import site_config

    cfg = site_config.get()          # full config dict
    fc  = site_config.frontend()     # subset safe for the browser
    site_config.save(new_cfg)        # persist changes
"""

import json
import os
import threading

import config as _env  # environment-variable based config (fallback)

_DEFAULTS: dict = {
    "site_name": "",
    "operator": "",
    "map": {
        "center_lat": 0.0,
        "center_lon": 0.0,
        "default_zoom": 13,
        "tv_position_center_lat": 0.0,
        "tv_position_center_lon": 0.0,
        "tv_position_radius_km": 150.0,
    },
    "lines": {
        "stadstrafiken": [],
        "lansbuss": [],
        "tag_i_bergslagen": [],
    },
    "line_colors": {},
    "station_presets": [],
    "trafikverket": {
        "stations": {},
        "operators": [],
        "lookahead_minutes": 120,
        "poll_seconds": 60,
    },
    "features": {
        "oxyfi_enabled": True,
        "stadstrafiken_page": True,
        "driftsplats_overlay": True,
        "traffic_inference": True,
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge *override* into *base* (non-destructive)."""
    merged = dict(base)
    for key, val in override.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(val, dict):
            merged[key] = _deep_merge(merged[key], val)
        else:
            merged[key] = val
    return merged


def _env_fallbacks() -> dict:
    """Build a config dict from environment variables (backward compat)."""
    tv_stations = dict(_env.TRAFIKVERKET_STATIONS) if _env.TRAFIKVERKET_STATIONS else {}
    tv_operators = sorted(_env.TRAFIKVERKET_OPERATORS) if _env.TRAFIKVERKET_OPERATORS else []
    return {
        "site_name": os.environ.get("SITE_NAME", ""),
        "operator": _env.OPERATOR,
        "map": {
            "center_lat": _env.MAP_CENTER_LAT,
            "center_lon": _env.MAP_CENTER_LON,
            "default_zoom": _env.MAP_DEFAULT_ZOOM,
            "tv_position_center_lat": _env.TV_POSITION_CENTER_LAT,
            "tv_position_center_lon": _env.TV_POSITION_CENTER_LON,
            "tv_position_radius_km": _env.TV_POSITION_RADIUS_KM,
        },
        "lines": {
            "stadstrafiken": [],
            "lansbuss": [],
            "tag_i_bergslagen": [],
        },
        "line_colors": {},
        "station_presets": [],
        "trafikverket": {
            "stations": tv_stations,
            "operators": tv_operators,
            "lookahead_minutes": _env.TRAFIKVERKET_LOOKAHEAD_MINUTES,
            "poll_seconds": _env.TRAFIKVERKET_POLL_SECONDS,
        },
        "features": {
            "oxyfi_enabled": bool(_env.OXYFI_API_KEY),
            "stadstrafiken_page": True,
            "driftsplats_overlay": True,
            "traffic_inference": _env.TRAFFIC_ENABLED,
        },
    }


class SiteConfigStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._config: dict = {}
        self._path: str = ""

    def init(self, path: str) -> None:
        """Load config from *path*, merging with env fallbacks."""
        self._path = path
        self._reload()

    def _reload(self) -> None:
        base = _deep_merge(_DEFAULTS, _env_fallbacks())
        disk = {}
        if self._path and os.path.isfile(self._path):
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    disk = json.load(f)
            except (json.JSONDecodeError, OSError):
                pass
        with self._lock:
            self._config = _deep_merge(base, disk)

    def get(self) -> dict:
        """Return full config (safe copy)."""
        with self._lock:
            return json.loads(json.dumps(self._config))

    def frontend(self) -> dict:
        """Return frontend-safe subset (no API keys or internal details)."""
        cfg = self.get()
        return {
            "site_name": cfg["site_name"],
            "operator": cfg["operator"],
            "map": cfg["map"],
            "lines": cfg["lines"],
            "line_colors": cfg["line_colors"],
            "station_presets": cfg["station_presets"],
            "features": cfg["features"],
        }

    def save(self, data: dict) -> None:
        """Validate, merge with defaults, persist to disk, and reload."""
        merged = _deep_merge(_DEFAULTS, data)
        os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
        with open(self._path, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2, ensure_ascii=False)
        self._reload()

    def patch(self, partial: dict) -> dict:
        """Merge *partial* into current config, save, and return result."""
        current = self.get()
        updated = _deep_merge(current, partial)
        self.save(updated)
        return self.get()


# Application-wide singleton
site_config = SiteConfigStore()
