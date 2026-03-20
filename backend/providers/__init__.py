"""Data provider abstractions.

Each provider owns one data domain:

  - BusProvider  → GTFS static data + GTFS-RT bus positions / trip updates
  - TrainProvider → Trafikverket API (positions, announcements) + Oxyfi WebSocket

Providers write to the typed stores in data/:

    from data.gtfs_store import gtfs_store
    from data.vehicle_store import vehicle_store
    from data.train_store import train_store

New integrations (e.g. a new operator API) should follow the same pattern:
create a new store class in data/ and a new provider class here.
"""

from typing import Protocol


class VehicleProvider(Protocol):
    """Minimal contract for anything that supplies vehicle positions."""

    def get_vehicles(self) -> list[dict]:
        """Return current vehicle positions as a list of dicts."""
        ...

    def poll(self) -> None:
        """Fetch the latest data from upstream and update the store."""
        ...
