"""GTFS static data store.

Owns all data that comes from the GTFS static feed (routes, stops, trips,
shapes, timetables).  Has its own lock so GTFS refreshes never block the
bus or train polling threads.

Usage:
    from stores.gtfs_store import gtfs_store

    # Read (take lock):
    with gtfs_store.lock:
        routes = dict(gtfs_store.routes)

    # Atomic full update (called by bus_provider after a fresh download):
    gtfs_store.update_snapshot(snapshot)
"""

import threading


class GtfsStore:
    def __init__(self):
        self.lock = threading.Lock()

        # GTFS static tables
        self.routes: dict = {}          # route_id -> route dict
        self.stops: dict = {}           # stop_id -> stop dict
        self.trips: dict = {}           # trip_id -> trip dict
        self.shapes: dict = {}          # shape_id -> list of [lat, lon]
        self.trip_headsigns: dict = {}  # trip_id -> headsign override
        self.stop_route_map: dict = {}  # stop_id -> list of route_ids

        # Derived timetable data rebuilt each day at midnight
        self.static_stop_departures: dict = {}  # stop_id -> [departure dicts]
        self.static_stop_arrivals: dict = {}    # stop_id -> [arrival dicts]
        self.trip_origin_map: dict = {}         # trip_id -> origin stop_id
        self.rt_trip_short_names: dict = {}     # rt trip_id -> short name
        self.agencies: dict = {}                # agency_id -> agency dict

        # Status
        self.loaded: bool = False
        self.error: str | None = None

    def update_snapshot(self, snapshot: dict) -> None:
        """Atomically replace all GTFS tables (called after download or daily refresh)."""
        with self.lock:
            for attr, value in snapshot.items():
                if hasattr(self, attr):
                    setattr(self, attr, value)
            self.loaded = True
            self.error = None

    def set_error(self, message: str) -> None:
        with self.lock:
            self.error = message
            self.loaded = False


# Application-wide singleton
gtfs_store = GtfsStore()
