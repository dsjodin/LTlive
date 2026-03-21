"""Train data provider — Trafikverket API + Oxyfi WebSocket.

Owns:
  - Fetching TrainStation metadata
  - Streaming TrainPosition updates via Trafikverket SSE
  - Polling TrainAnnouncement + StationMessages
  - Writing results to data/train_store.py

Nothing in this file touches bus or GTFS-RT logic.
"""

import threading
import time

import config
import trafikverket as tv_api
from stores.cache import api_cache
from stores.train_store import train_store


# ---------------------------------------------------------------------------
# Position update helper (called from SSE stream loop)
# ---------------------------------------------------------------------------

def update_tv_positions(new_positions: list) -> None:
    """Merge a batch of streaming TrainPosition updates into train_store.

    Entries with deleted=True remove the train; all others replace/insert.
    """
    with train_store.lock:
        current = {p["train_number"]: p
                   for p in train_store.positions
                   if p.get("train_number")}
        for p in new_positions:
            tn = p.get("train_number")
            if not tn:
                continue
            if p.get("deleted"):
                current.pop(tn, None)
            else:
                current[tn] = p
        train_store.positions = list(current.values())


# ---------------------------------------------------------------------------
# Trafikverket SSE position stream (runs in its own daemon thread)
# ---------------------------------------------------------------------------

def run_tv_position_stream() -> None:
    """Subscribe to TrainPosition changes via Trafikverket SSE.

    Flow (as recommended by TRV docs):
      1. POST with sseurl=true → get snapshot of current positions + SSEURL
      2. Connect to SSEURL     → receive all future changes in real time
      3. On 404 (endpoint expired) → go to step 1
      4. On other errors           → reconnect to same SSEURL + lasteventid
                                     with exponential back-off
    """
    import requests as _requests  # local import to avoid circular at module level

    last_event_id: str | None = None
    sseurl: str | None = None
    backoff = 5

    while True:
        try:
            if not sseurl:
                positions, sseurl = tv_api.fetch_position_sseurl()
                if not positions and not sseurl:
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 300)
                    continue
                with train_store.lock:
                    train_store.positions  = positions
                    train_store.last_poll  = int(time.time())
                    train_store.last_error = None
                last_event_id = None
                if not sseurl:
                    print("tv-sse: no SSEURL returned — position streaming unavailable")
                    return

            print(f"tv-sse: connecting (last_event_id={last_event_id})")
            with train_store.lock:
                train_store.sse_state = "connected"

            for event_id, positions in tv_api.iter_position_stream(sseurl, last_event_id):
                last_event_id = event_id
                backoff = 5
                update_tv_positions(positions)
                with train_store.lock:
                    train_store.last_poll  = int(time.time())
                    train_store.last_error = None
                    train_store.sse_state  = "connected"

            print("tv-sse: stream closed, reconnecting")
            with train_store.lock:
                train_store.sse_state = "reconnecting"
            time.sleep(2)

        except _requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else 0
            if status == 404:
                print("tv-sse: endpoint expired (404), recreating")
                sseurl = None
                last_event_id = None
            else:
                print(f"tv-sse: HTTP {status}, recreating endpoint")
                with train_store.lock:
                    train_store.last_error = f"HTTP {status}"
                sseurl = None
                last_event_id = None
                time.sleep(backoff)
                backoff = min(backoff * 2, 300)
            with train_store.lock:
                train_store.sse_state = "reconnecting"

        except Exception as exc:
            print(f"tv-sse: error: {exc}")
            with train_store.lock:
                train_store.last_error = str(exc)
                train_store.sse_state  = "reconnecting"
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)


# ---------------------------------------------------------------------------
# Trafikverket announcement polling
# ---------------------------------------------------------------------------

def poll_trafikverket() -> None:
    """Fetch TrainAnnouncement + StationMessages (positions come via SSE stream)."""
    loc_sigs = list(config.TRAFIKVERKET_STATIONS.values())
    if not loc_sigs:
        return
    try:
        announcements = tv_api.fetch_announcements(
            loc_sigs, minutes_ahead=config.TRAFIKVERKET_LOOKAHEAD_MINUTES
        )
        messages = tv_api.fetch_station_messages(loc_sigs)
        with train_store.lock:
            if announcements:
                train_store.update_announcements(announcements)
            train_store.messages   = messages
            train_store.last_error = None
        # Announcement updates affect departure boards only.
        api_cache.invalidate_prefix("dep")
    except Exception as exc:
        print(f"tv-poll error: {exc}")
        with train_store.lock:
            train_store.last_error = str(exc)


# ---------------------------------------------------------------------------
# Startup initializer (called once from scheduler/app startup)
# ---------------------------------------------------------------------------

def init_trafikverket() -> None:
    """Load TrainStation lookup table, start SSE position stream, do first announcement poll."""
    stations = tv_api.fetch_train_stations()
    with train_store.lock:
        train_store.stations = stations
    threading.Thread(target=run_tv_position_stream, daemon=True, name="tv-sse").start()
    poll_trafikverket()
