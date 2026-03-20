"""Vehicle enrichment — shared between /api/vehicles and the SSE stream.

Extracted from app.py so it can be imported by both the blueprint and
the SSE push function without circular imports.
"""

from store import _data, _lock


def enrich_vehicles(vehicle_list):
    """Enrich vehicle list with route/trip/stop info."""
    with _lock:
        routes = _data["routes"]
        stops = _data["stops"]
        trips = _data["trips"]
        trip_headsigns = _data["trip_headsigns"]

    enriched = []
    for v in vehicle_list:
        route_info = {}
        trip_id = v.get("trip_id", "")
        trip_info = trips.get(trip_id, {})
        route_id = v.get("route_id") or trip_info.get("route_id", "")
        if route_id:
            route_info = routes.get(route_id, {})

        headsign = trip_info.get("trip_headsign", "")
        if not headsign and trip_id:
            headsign = trip_headsigns.get(trip_id, "")
        if not headsign:
            headsign = route_info.get("route_long_name", "")

        stop_id = v.get("current_stop_id", "")
        next_stop = stops.get(stop_id, {}) if stop_id else {}
        next_stop_name = next_stop.get("stop_name", "")
        next_stop_platform = next_stop.get("platform_code", "")

        enriched.append({
            **v,
            "route_id": route_id,
            "route_short_name": route_info.get("route_short_name", ""),
            "route_long_name": route_info.get("route_long_name", ""),
            "route_color": route_info.get("route_color", "0074D9"),
            "route_text_color": route_info.get("route_text_color", "FFFFFF"),
            "trip_headsign": headsign,
            "next_stop_name": next_stop_name,
            "next_stop_platform": next_stop_platform,
        })
    return enriched
