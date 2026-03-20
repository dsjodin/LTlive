"""Bus vehicle data store.

Owns all data produced by the GTFS-RT pipeline (live vehicle positions,
trip updates, stop-level departure boards, service alerts).  Has its own
lock so bus polling never blocks train polling or GTFS refreshes.

Usage:
    from stores.vehicle_store import vehicle_store

    # Read:
    with vehicle_store.lock:
        vehicles = list(vehicle_store.vehicles)
        ts = vehicle_store.last_vehicle_update

    # Write (called by bus_provider):
    with vehicle_store.lock:
        vehicle_store.vehicles = new_list
        vehicle_store.last_vehicle_update = time.time()
"""

import threading


class VehicleStore:
    def __init__(self):
        self.lock = threading.Lock()

        # Live vehicle positions from GTFS-RT VehiclePositions feed
        self.vehicles: list = []
        self.vehicle_trips: dict = {}       # vehicle_id -> trip info
        self.vehicle_next_stop: dict = {}   # vehicle_id -> next stop info

        # Per-stop real-time departure boards (from TripUpdates)
        self.stop_departures: dict = {}     # stop_id -> [departure dicts]

        # Service alerts
        self.alerts: list = []

        # Polling metadata
        self.last_vehicle_update: float = 0
        self.last_rt_poll: float = 0
        self.last_rt_poll_count: int | None = None
        self.last_rt_error: str | None = None


# Application-wide singleton
vehicle_store = VehicleStore()
