"""Tests for in-memory data stores."""

import threading

from stores.gtfs_store import GtfsStore
from stores.vehicle_store import VehicleStore
from stores.train_store import TrainStore
from stores.cache import TTLCache


class TestGtfsStore:
    """Tests for GtfsStore."""

    def test_initial_state(self):
        store = GtfsStore()
        assert store.routes == {}
        assert store.stops == {}
        assert store.trips == {}
        assert store.loaded is False
        assert store.error is None

    def test_routes_assignment(self):
        store = GtfsStore()
        store.routes = {"R1": {"route_short_name": "1"}}
        assert "R1" in store.routes
        assert store.routes["R1"]["route_short_name"] == "1"

    def test_thread_safety(self):
        store = GtfsStore()
        errors = []

        def writer():
            try:
                for i in range(100):
                    with store.lock:
                        store.routes[f"R{i}"] = {"name": f"Route {i}"}
            except Exception as e:
                errors.append(e)

        def reader():
            try:
                for _ in range(100):
                    with store.lock:
                        _ = dict(store.routes)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer), threading.Thread(target=reader)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == []
        assert len(store.routes) == 100


class TestVehicleStore:
    """Tests for VehicleStore."""

    def test_initial_state(self):
        store = VehicleStore()
        assert store.vehicles == []
        assert store.alerts == []
        assert store.vehicle_trips == {}

    def test_update_vehicles(self):
        store = VehicleStore()
        store.vehicles = [{"id": "v1", "lat": 59.0}]
        assert len(store.vehicles) == 1


class TestTrainStore:
    """Tests for TrainStore."""

    def test_initial_state(self):
        store = TrainStore()
        assert store.announcements == {}
        assert store.stations == {}
        assert store.positions == []


class TestTTLCache:
    """Tests for TTL-based cache."""

    def test_set_and_get(self):
        cache = TTLCache()
        cache.set("key1", {"data": "value"}, ttl=60)
        result = cache.get("key1")
        assert result == {"data": "value"}

    def test_get_missing_key(self):
        cache = TTLCache()
        assert cache.get("missing") is None

    def test_clear(self):
        cache = TTLCache()
        cache.set("key1", "val1", ttl=60)
        cache.set("key2", "val2", ttl=60)
        cache.clear()
        assert cache.get("key1") is None
        assert cache.get("key2") is None

    def test_invalidate_prefix(self):
        cache = TTLCache()
        cache.set(("dep", "stop1", 10, False), "data1", ttl=60)
        cache.set(("dep", "stop2", 10, False), "data2", ttl=60)
        cache.set("vehicles", "vdata", ttl=60)
        cache.invalidate_prefix("dep")
        assert cache.get(("dep", "stop1", 10, False)) is None
        assert cache.get("vehicles") == "vdata"
