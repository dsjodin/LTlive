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
        # segment_id -> {shape_id, route_ids, geometry, stop_zone, signal_zone,
        #                terminal_zone, start_m, end_m}
        self.segments: dict = {}

        # shape_id -> list of cumulative distances per shape point
        self.shape_cumul: dict = {}

        # shape_id -> list of [lat, lon] (copy from gtfs_store for fast access)
        self.shape_coords: dict = {}

        # Real-time state per segment
        # segment_id -> {observations: deque, severity, confidence,
        #                current_speed_kmh, expected_speed_kmh, speed_ratio,
        #                affected_vehicles, unique_routes,
        #                delay_onset_count, delay_onset_evidence}
        self.segment_states: dict = {}

        # Track last known position per vehicle for speed calculation
        # vehicle_id -> {lat, lon, timestamp, segment_id, distance_along,
        #                shape_id, delay_seconds}
        self.vehicle_last_pos: dict = {}

        # Delay tracking per vehicle: vehicle_id -> delay_seconds at last poll
        self.vehicle_last_delay: dict = {}

        # Delay onset events (recent):
        # segment_id -> deque of {vehicle_id, delta_delay, timestamp}
        self.delay_onset_events: dict = {}

        # Signal zones detected from OSM or GPS clusters
        # list of {lat, lon, radius_m, source}
        self.signal_zones: list = []

        # Terminal stop positions for filtering
        # set of (lat, lon) tuples
        self.terminal_positions: set = set()

        # Historical baseline: "segment_id:weekday_type:hour" -> {mean, count}
        self.baseline_speeds: dict = {}

        # Status
        self.built: bool = False
        self.segment_count: int = 0
        self.signal_zone_count: int = 0


# Application-wide singleton
traffic_store = TrafficStore()
