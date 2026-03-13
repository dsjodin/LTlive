"""Fetch and parse GTFS-RT realtime feeds (VehiclePositions)."""

import time
from google.transit import gtfs_realtime_pb2
import requests

import config


def fetch_vehicle_positions():
    """Fetch GTFS-RT VehiclePositions feed and return list of vehicle dicts."""
    try:
        resp = requests.get(config.VEHICLE_POSITIONS_URL, timeout=10)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"Error fetching vehicle positions: {e}")
        return []

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(resp.content)

    vehicles = []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        v = entity.vehicle
        pos = v.position
        if not pos.latitude or not pos.longitude:
            continue

        # Map GTFS-RT VehicleStopStatus to Swedish labels
        status_map = {
            0: "Ankommande",    # INCOMING_AT
            1: "Vid hållplats", # STOPPED_AT
            2: "I trafik",      # IN_TRANSIT_TO
        }
        current_status = status_map.get(v.current_status, "I trafik")

        vehicle = {
            "id": entity.id,
            "vehicle_id": v.vehicle.id if v.vehicle.id else entity.id,
            "label": v.vehicle.label if v.vehicle.label else "",
            "lat": pos.latitude,
            "lon": pos.longitude,
            "bearing": pos.bearing if pos.bearing else None,
            "speed": pos.speed if pos.speed else None,
            "current_status": current_status,
            "trip_id": v.trip.trip_id if v.HasField("trip") else "",
            "route_id": v.trip.route_id if v.HasField("trip") else "",
            "direction_id": v.trip.direction_id if v.HasField("trip") else None,
            "start_date": v.trip.start_date if v.HasField("trip") else "",
            "timestamp": v.timestamp if v.timestamp else int(time.time()),
        }
        vehicles.append(vehicle)

    return vehicles


def fetch_service_alerts():
    """Fetch GTFS-RT ServiceAlerts feed."""
    try:
        resp = requests.get(config.SERVICE_ALERTS_URL, timeout=10)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"Error fetching service alerts: {e}")
        return []

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(resp.content)

    alerts = []
    for entity in feed.entity:
        if not entity.HasField("alert"):
            continue
        a = entity.alert
        header = ""
        description = ""
        if a.header_text and a.header_text.translation:
            header = a.header_text.translation[0].text
        if a.description_text and a.description_text.translation:
            description = a.description_text.translation[0].text

        affected_routes = []
        for ie in a.informed_entity:
            if ie.route_id:
                affected_routes.append(ie.route_id)

        alerts.append({
            "id": entity.id,
            "header": header,
            "description": description,
            "affected_routes": affected_routes,
        })

    return alerts
