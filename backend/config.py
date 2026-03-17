import os

# Support a single key or separate keys for static/realtime
_default_key = os.environ.get("TRAFIKLAB_API_KEY", "")
TRAFIKLAB_GTFS_RT_KEY = os.environ.get("TRAFIKLAB_GTFS_RT_KEY", "") or _default_key
TRAFIKLAB_GTFS_STATIC_KEY = os.environ.get("TRAFIKLAB_GTFS_STATIC_KEY", "") or TRAFIKLAB_GTFS_RT_KEY or _default_key

OPERATOR = os.environ.get("OPERATOR", "orebro")

GTFS_STATIC_URL = (
    f"https://opendata.samtrafiken.se/gtfs/{OPERATOR}/{OPERATOR}.zip"
    f"?key={TRAFIKLAB_GTFS_STATIC_KEY}"
)

GTFS_RT_BASE = f"https://opendata.samtrafiken.se/gtfs-rt/{OPERATOR}"

VEHICLE_POSITIONS_URL = f"{GTFS_RT_BASE}/VehiclePositions.pb?key={TRAFIKLAB_GTFS_RT_KEY}"
TRIP_UPDATES_URL = f"{GTFS_RT_BASE}/TripUpdates.pb?key={TRAFIKLAB_GTFS_RT_KEY}"
SERVICE_ALERTS_URL = f"{GTFS_RT_BASE}/ServiceAlerts.pb?key={TRAFIKLAB_GTFS_RT_KEY}"

GTFS_DATA_DIR = os.environ.get("GTFS_DATA_DIR", "/app/data/gtfs")
GTFS_REFRESH_HOURS = int(os.environ.get("GTFS_REFRESH_HOURS", "48"))

RT_POLL_SECONDS = int(os.environ.get("RT_POLL_SECONDS", "180"))

NEARBY_RADIUS_METERS = int(os.environ.get("NEARBY_RADIUS_METERS", "400"))

# Agency ID for Tåg i Bergslagen in the Samtrafiken GTFS.
# Leave empty to show all train operators; set to filter to TiB only.
# Run /api/debug/agencies after startup to find the correct value.
TIB_AGENCY_ID = os.environ.get("TIB_AGENCY_ID", "")

# Comma-separated list of route_short_names to include in departure/arrival
# boards. Takes priority over TIB_AGENCY_ID. Leave empty for no filter.
# Example: "T53,T63,T66,T68,T72"
# Run /api/routes/trains after startup to see available route short names.
_route_names_env = os.environ.get("TIB_ROUTE_SHORT_NAMES", "")
TIB_ROUTE_SHORT_NAMES: set = (
    {n.strip() for n in _route_names_env.split(",") if n.strip()}
    if _route_names_env else set()
)

# Override route colors when the GTFS data uses a generic regional color.
# Format: comma-separated "ROUTE_SHORT_NAME:RRGGBB" pairs.
# TiB brand green: 2C6E37  (e.g. "T53:2C6E37,T54:2C6E37,T63:2C6E37")
_color_overrides_env = os.environ.get("ROUTE_COLOR_OVERRIDES", "")
ROUTE_COLOR_OVERRIDES: dict = {}
for _entry in _color_overrides_env.split(","):
    _entry = _entry.strip()
    if ":" in _entry:
        _k, _v = _entry.split(":", 1)
        ROUTE_COLOR_OVERRIDES[_k.strip()] = _v.strip().lstrip("#")
FRONTEND_POLL_INTERVAL_MS = int(os.environ.get("FRONTEND_POLL_INTERVAL_MS", "5000"))

# Trafikverket Open Data API
# Register at api.trafikinfo.trafikverket.se — free, separate from Trafiklab.
TRAFIKVERKET_API_KEY = os.environ.get("TRAFIKVERKET_API_KEY", "")

# Map GTFS stop_id → Trafikverket LocationSignature for train stations.
# Format: comma-separated "STOP_ID:LOCATION_SIG" pairs.
# Example: "740000400:Ör,740000015:Hpbg,740000001:Cst"
# Run /api/debug/stops to find GTFS stop_ids and /api/debug/tv-stations
# to browse Trafikverket station codes after providing TRAFIKVERKET_API_KEY.
_tv_stations_env = os.environ.get("TRAFIKVERKET_STATIONS", "")
TRAFIKVERKET_STATIONS: dict = {}
for _entry in _tv_stations_env.split(","):
    _entry = _entry.strip()
    if ":" in _entry:
        _stop_id, _loc_sig = _entry.split(":", 1)
        TRAFIKVERKET_STATIONS[_stop_id.strip()] = _loc_sig.strip()

# How many minutes ahead to fetch TrainAnnouncement data.
TRAFIKVERKET_LOOKAHEAD_MINUTES = int(os.environ.get("TRAFIKVERKET_LOOKAHEAD_MINUTES", "120"))

# How often to refresh TV announcement data (seconds).
TRAFIKVERKET_POLL_SECONDS = int(os.environ.get("TRAFIKVERKET_POLL_SECONDS", "60"))

# Oxyfi Realtidspositionering — train positions via WebSocket
# Register at trafiklab.se and add the "Oxyfi-Realtidspositionering" API to your project.
OXYFI_API_KEY = os.environ.get("OXYFI_API_KEY", "")
# Bronze: max ~180s (30 000 req/30 days ÷ 2 feeds)
# Silver: ok med 5s (2 000 000 req/30 days)
