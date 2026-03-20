"""Traffic inference data store.

Holds corridor segments, real-time segment states, vehicle tracking state,
and historical baseline speeds.  Thread-safe via its own lock.

Usage:
    from stores.traffic_store import traffic_store

    with traffic_store.lock:
        states = dict(traffic_store.segment_states)
"""

import threading
from collections import deque


class TrafficStore:
    def __init__(self):
        self.lock = threading.Lock()

        # Built once from GTFS shapes (by build_segments)
        # segment_id -> {shape_id, route_ids, geometry, stop_zone, start_m, end_m}
        self.segments: dict = {}

        # shape_id -> list of cumulative distances per shape point
        self.shape_cumul: dict = {}

        # shape_id -> list of [lat, lon] (copy from gtfs_store for fast access)
        self.shape_coords: dict = {}

        # Real-time state per segment
        # segment_id -> {observations: deque, severity, confidence,
        #                current_speed_kmh, expected_speed_kmh, speed_ratio,
        #                affected_vehicles, unique_routes}
        self.segment_states: dict = {}

        # Track last known position per vehicle for speed calculation
        # vehicle_id -> {lat, lon, timestamp, segment_id, distance_along}
        self.vehicle_last_pos: dict = {}

        # Historical baseline: (segment_id, weekday_type, hour) -> {mean, count}
        self.baseline_speeds: dict = {}

        # Status
        self.built: bool = False
        self.segment_count: int = 0


# Application-wide singleton
traffic_store = TrafficStore()
