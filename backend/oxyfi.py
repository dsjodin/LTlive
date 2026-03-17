"""Oxyfi Realtidspositionering – WebSocket client for train positions.

Connects to wss://api.oxyfi.com/trainpos/listen?v=1&key=... and parses
incoming NMEA GPRMC messages extended by Oxyfi with vehicleId and
public train number fields.

Thread-safe: get_trains() can be called from any thread at any time.
"""

import threading
import time

try:
    import websocket
    _WS_AVAILABLE = True
except ImportError:
    _WS_AVAILABLE = False

import config

_trains: dict = {}      # vehicleId -> vehicle dict
_trains_lock = threading.Lock()
_last_update: int = 0   # epoch seconds of last position update


# ---------------------------------------------------------------------------
# NMEA helpers
# ---------------------------------------------------------------------------

def _parse_nmea_coord(val: str, hemi: str):
    """Convert NMEA DDDMM.MMMM + hemisphere to decimal degrees, or None."""
    if not val:
        return None
    try:
        dot = val.index(".")
        deg_digits = dot - 2  # always 2 minute digits before the decimal point
        degrees = float(val[:deg_digits])
        minutes = float(val[deg_digits:])
        dec = degrees + minutes / 60.0
        if hemi in ("S", "W"):
            dec = -dec
        return round(dec, 6)
    except (ValueError, IndexError):
        return None


def _knots_to_ms(knots_str: str):
    """Convert knot string to m/s, or None."""
    try:
        return round(float(knots_str) * 0.514444, 2)
    except (ValueError, TypeError):
        return None


def _strip_checksum(field: str) -> str:
    """Remove NMEA checksum suffix '*XX' from a field value."""
    idx = field.find("*")
    return field[:idx] if idx >= 0 else field


def parse_oxyfi_message(msg: str):
    """Parse one Oxyfi NMEA GPRMC message string.

    Expected format (18 comma-separated fields, 0-indexed):
      0  $GPRMC
      1  HHMMSS          UTC time
      2  A/V             status  (A = active / valid)
      3  DDMM.MMMM       latitude
      4  N/S
      5  DDDMM.MMMM      longitude
      6  E/W
      7  speed (knots)
      8  bearing (degrees)
      9  DDMMYY          date
      10 magnetic variation
      11 E/W + *checksum
      12 (empty)
      13 vehicleId       e.g. "1421.trains.se"
      14 (empty)
      15 train numbers   semicolon-separated, e.g. "8955.public.trains.se@2012-12-10"
      16 "oxyfi"

    Returns a vehicle dict or None.
    """
    msg = msg.strip()
    if not msg.startswith("$GPRMC"):
        return None

    parts = msg.split(",")
    if len(parts) < 12:
        return None

    status = parts[2]
    if status != "A":
        return None

    lat = _parse_nmea_coord(parts[3], parts[4])
    lon = _parse_nmea_coord(parts[5], parts[6])
    if lat is None or lon is None:
        return None

    speed = _knots_to_ms(parts[7]) if len(parts) > 7 and parts[7] else None
    bearing_str = _strip_checksum(parts[8]) if len(parts) > 8 else ""
    try:
        bearing = float(bearing_str) if bearing_str else None
    except ValueError:
        bearing = None

    vehicle_id = parts[13].strip() if len(parts) > 13 else ""
    if not vehicle_id:
        return None

    # Parse public train numbers from field 15
    train_numbers_raw = parts[15].strip() if len(parts) > 15 else ""
    public_numbers = []
    for entry in train_numbers_raw.split(";"):
        entry = entry.strip()
        if ".public.trains.se" in entry:
            num = entry.split(".public.trains.se")[0]
            if num:
                public_numbers.append(num)

    # Use the first public train number as label; fall back to numeric part of vehicleId
    label = public_numbers[0] if public_numbers else vehicle_id.split(".")[0]

    return {
        "id": f"oxyfi_{vehicle_id}",
        "vehicle_id": vehicle_id,
        "label": label,
        "lat": lat,
        "lon": lon,
        "bearing": bearing,
        "speed": speed,
        "current_status": "I trafik",
        "current_stop_id": "",
        "trip_id": "",
        "route_id": "",
        "direction_id": None,
        "start_date": "",
        "timestamp": int(time.time()),
        "vehicle_type": "train",
        # Pre-populated route styling — trains are not in Örebro GTFS
        "route_short_name": label,
        "route_long_name": "Tåg i Bergslagen",
        "route_color": "E87722",    # TiB orange
        "route_text_color": "FFFFFF",
        "trip_headsign": "",
        "next_stop_name": "",
        "next_stop_platform": "",
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_trains() -> list:
    """Return a snapshot of current train positions.

    Positions older than 30 seconds are excluded (train has gone off-line or
    the WebSocket reconnected).
    """
    cutoff = int(time.time()) - 30
    with _trains_lock:
        return [v.copy() for v in _trains.values() if v["timestamp"] >= cutoff]


def start() -> None:
    """Start the Oxyfi WebSocket listener in a background daemon thread.

    Safe to call multiple times — only starts once if the key is configured.
    """
    if not _WS_AVAILABLE:
        print("oxyfi: websocket-client not installed — train tracking disabled")
        return
    if not config.OXYFI_API_KEY:
        print("oxyfi: OXYFI_API_KEY not set — train tracking disabled")
        return
    threading.Thread(target=_run_forever, daemon=True, name="oxyfi-ws").start()
    print("oxyfi: WebSocket thread started")


# ---------------------------------------------------------------------------
# Internal WebSocket management
# ---------------------------------------------------------------------------

_reconnect_count: int = 0

def _run_forever() -> None:
    """Reconnect loop — runs in background thread.

    Uses exponential backoff capped at 10 minutes.  After 20 failed
    reconnects in a row the loop gives up entirely to protect quota
    (24 000 requests / 30 days ≈ 800 / day — one persistent connection
    costs just 1 request; this guard prevents a crash-loop from burning
    through them).
    """
    global _reconnect_count
    backoff = 5
    while True:
        try:
            _connect()
            # Clean disconnect — reset counters
            backoff = 5
            _reconnect_count = 0
        except Exception as e:
            print(f"oxyfi: connection error: {e}")

        _reconnect_count += 1
        if _reconnect_count > 20:
            print("oxyfi: too many reconnects — giving up to protect API quota. "
                  "Restart the service to retry.")
            return

        print(f"oxyfi: reconnecting in {backoff}s… (attempt {_reconnect_count}/20)")
        time.sleep(backoff)
        backoff = min(backoff * 2, 600)  # cap at 10 minutes


def _connect() -> None:
    global _last_update

    url = f"wss://api.oxyfi.com/trainpos/listen?v=1&key={config.OXYFI_API_KEY}"

    _msg_count = [0]

    def on_message(ws, message):
        global _last_update
        vehicle = parse_oxyfi_message(message)
        if vehicle:
            with _trains_lock:
                _trains[vehicle["vehicle_id"]] = vehicle
            _last_update = vehicle["timestamp"]
            _msg_count[0] += 1
            if _msg_count[0] <= 3 or _msg_count[0] % 100 == 0:
                print(f"oxyfi: received train {vehicle['vehicle_id']} pos {vehicle['lat']},{vehicle['lon']} (#{_msg_count[0]})")

    def on_error(ws, error):
        print(f"oxyfi: WebSocket error: {error}")

    def on_close(ws, code, msg):
        print(f"oxyfi: connection closed ({code} {msg})")

    def on_open(ws):
        print("oxyfi: connected — receiving train positions")

    ws = websocket.WebSocketApp(
        url,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
        on_open=on_open,
    )
    ws.run_forever(ping_interval=30, ping_timeout=10)
