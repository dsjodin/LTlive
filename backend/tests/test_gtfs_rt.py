"""Tests for GTFS-RT feed parsing logic."""

import time
from unittest.mock import patch, MagicMock
from google.transit import gtfs_realtime_pb2

import gtfs_rt


def _make_vehicle_feed(vehicles):
    """Build a GTFS-RT FeedMessage with VehiclePosition entities."""
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    feed.header.timestamp = int(time.time())

    for v in vehicles:
        entity = feed.entity.add()
        entity.id = v["id"]
        vp = entity.vehicle
        vp.vehicle.id = v.get("vehicle_id", v["id"])
        vp.vehicle.label = v.get("label", "")
        vp.position.latitude = v["lat"]
        vp.position.longitude = v["lon"]
        vp.position.bearing = v.get("bearing", 0.0)
        vp.position.speed = v.get("speed", 0.0)
        if "trip_id" in v:
            vp.trip.trip_id = v["trip_id"]
            vp.trip.route_id = v.get("route_id", "")
    return feed


def _make_alerts_feed(alerts):
    """Build a GTFS-RT FeedMessage with Alert entities."""
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    feed.header.timestamp = int(time.time())

    for a in alerts:
        entity = feed.entity.add()
        entity.id = a["id"]
        alert = entity.alert
        if "header" in a:
            t = alert.header_text.translation.add()
            t.text = a["header"]
            t.language = "sv"
        if "description" in a:
            t = alert.description_text.translation.add()
            t.text = a["description"]
            t.language = "sv"
        for route_id in a.get("routes", []):
            ie = alert.informed_entity.add()
            ie.route_id = route_id
    return feed


class TestFetchVehiclePositions:
    """Tests for fetch_vehicle_positions()."""

    @patch("gtfs_rt.requests.get")
    def test_parses_vehicles(self, mock_get):
        feed = _make_vehicle_feed([
            {"id": "v1", "lat": 59.27, "lon": 15.21, "trip_id": "trip1", "route_id": "R1"},
            {"id": "v2", "lat": 59.28, "lon": 15.22},
        ])
        mock_resp = MagicMock()
        mock_resp.content = feed.SerializeToString()
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        vehicles, error = gtfs_rt.fetch_vehicle_positions()

        assert error is None
        assert len(vehicles) == 2
        assert vehicles[0]["vehicle_id"] == "v1"
        assert vehicles[0]["lat"] == pytest.approx(59.27, abs=0.01)
        assert vehicles[0]["trip_id"] == "trip1"
        assert vehicles[0]["route_id"] == "R1"

    @patch("gtfs_rt.requests.get")
    def test_skips_zero_position(self, mock_get):
        feed = _make_vehicle_feed([
            {"id": "v1", "lat": 0, "lon": 0},
        ])
        mock_resp = MagicMock()
        mock_resp.content = feed.SerializeToString()
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        vehicles, error = gtfs_rt.fetch_vehicle_positions()

        assert error is None
        assert len(vehicles) == 0

    @patch("gtfs_rt.requests.get")
    def test_handles_network_error(self, mock_get):
        import requests
        mock_get.side_effect = requests.RequestException("Connection timeout")

        vehicles, error = gtfs_rt.fetch_vehicle_positions()

        assert vehicles == []
        assert "Connection timeout" in error


class TestFetchServiceAlerts:
    """Tests for fetch_service_alerts()."""

    @patch("gtfs_rt.requests.get")
    def test_parses_alerts(self, mock_get):
        feed = _make_alerts_feed([
            {
                "id": "alert1",
                "header": "Trafikstörning",
                "description": "Linje 1 inställd",
                "routes": ["R1", "R2"],
            },
        ])
        mock_resp = MagicMock()
        mock_resp.content = feed.SerializeToString()
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        alerts = gtfs_rt.fetch_service_alerts()

        assert len(alerts) == 1
        assert alerts[0]["header"] == "Trafikstörning"
        assert alerts[0]["description"] == "Linje 1 inställd"
        assert alerts[0]["affected_routes"] == ["R1", "R2"]

    @patch("gtfs_rt.requests.get")
    def test_handles_empty_feed(self, mock_get):
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.header.gtfs_realtime_version = "2.0"
        feed.header.timestamp = int(time.time())

        mock_resp = MagicMock()
        mock_resp.content = feed.SerializeToString()
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        alerts = gtfs_rt.fetch_service_alerts()
        assert alerts == []
