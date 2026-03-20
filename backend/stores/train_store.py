"""Train / Trafikverket data store.

Owns all data from the Trafikverket APIs and Oxyfi WebSocket
(train positions, announcements, station messages).  Has its own lock so
train polling never blocks the bus pipeline or GTFS refreshes.

Usage:
    from stores.train_store import train_store

    # Read:
    with train_store.lock:
        positions = list(train_store.positions)
        ann = dict(train_store.announcements)

    # Write (called by train_provider):
    with train_store.lock:
        train_store.positions = new_positions
        train_store.last_poll = time.time()
"""

import threading


class TrainStore:
    def __init__(self):
        self.lock = threading.Lock()

        # TrainAnnouncement: departure/arrival info per station
        self.announcements: dict = {}  # location_sig -> {departures: [...], arrivals: [...]}

        # TrainStation: station metadata
        self.stations: dict = {}       # location_sig -> {name, lat, lon}

        # TrainPosition: real-time GPS positions (via SSE stream)
        self.positions: list = []      # [{train_number, lat, lon, bearing, operator, ...}]

        # TrainStationMessage: platform announcements
        self.messages: dict = {}       # location_sig -> [{header, body, start, end}]

        # Polling / stream metadata
        self.last_poll: float = 0
        self.last_error: str | None = None
        self.sse_state: str = "disconnected"  # "connected" | "reconnecting" | "disconnected"


# Application-wide singleton
train_store = TrainStore()
