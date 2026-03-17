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
FRONTEND_POLL_INTERVAL_MS = int(os.environ.get("FRONTEND_POLL_INTERVAL_MS", "5000"))

# Oxyfi Realtidspositionering — train positions via WebSocket
# Register at trafiklab.se and add the "Oxyfi-Realtidspositionering" API to your project.
OXYFI_API_KEY = os.environ.get("OXYFI_API_KEY", "")
# Bronze: max ~180s (30 000 req/30 days ÷ 2 feeds)
# Silver: ok med 5s (2 000 000 req/30 days)
