"""Infer real-time road traffic impact from bus movement.

Buses act as floating probes.  Repeated abnormal slowdowns at the same
location across multiple vehicles indicate traffic-related problems.

Pipeline:
  1. build_segments()  — called once after GTFS static loads
  2. process_vehicle_positions()  — called after each RT poll
  3. Results read via traffic_store.segment_states → /api/traffic
"""

import datetime
import json
import math
import os
import time
import zoneinfo
from collections import defaultdict, deque
from statistics import median

import config
from stores.gtfs_store import gtfs_store
from stores.traffic_store import traffic_store

_TZ = zoneinfo.ZoneInfo("Europe/Stockholm")

# ---------------------------------------------------------------------------
# Geometry helpers (pure Python, no external deps)
# ---------------------------------------------------------------------------

_R_EARTH = 6_371_000  # metres


def _haversine(lat1, lon1, lat2, lon2):
    """Return distance in metres between two WGS-84 points."""
    rlat1, rlon1 = math.radians(lat1), math.radians(lon1)
    rlat2, rlon2 = math.radians(lat2), math.radians(lon2)
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return _R_EARTH * 2 * math.asin(math.sqrt(a))


def _point_to_line_segment(px, py, ax, ay, bx, by):
    """Project point P onto line segment AB.

    All coordinates are treated as flat (local metres) — the caller must
    pre-convert lat/lon to a local metric frame.

    Returns (distance_to_line, fraction_along_AB).
    fraction 0..1 is within the segment, <0 or >1 is clamped.
    """
    dx, dy = bx - ax, by - ay
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq < 1e-12:
        return math.hypot(px - ax, py - ay), 0.0

    t = ((px - ax) * dx + (py - ay) * dy) / seg_len_sq
    t = max(0.0, min(1.0, t))
    proj_x = ax + t * dx
    proj_y = ay + t * dy
    dist = math.hypot(px - proj_x, py - proj_y)
    return dist, t


def _latlon_to_local(lat, lon, ref_lat, ref_lon, cos_ref_lat):
    """Cheap flat-earth conversion relative to a reference point (metres)."""
    y = (lat - ref_lat) * 111_320.0
    x = (lon - ref_lon) * 111_320.0 * cos_ref_lat
    return x, y


# ---------------------------------------------------------------------------
# Segment builder
# ---------------------------------------------------------------------------

def build_segments():
    """Split every GTFS shape into ~100 m corridor segments.

    Writes results into traffic_store.  Safe to call multiple times
    (e.g. after a GTFS refresh).
    """
    with gtfs_store.lock:
        shapes = dict(gtfs_store.shapes)
        stops = dict(gtfs_store.stops)
        trips = dict(gtfs_store.trips)

    seg_len = config.TRAFFIC_SEGMENT_LENGTH_M
    stop_radius = config.TRAFFIC_STOP_ZONE_RADIUS_M

    # Collect stop positions for stop-zone tagging
    stop_positions = []
    for s in stops.values():
        lt = s.get("location_type", 0)
        if lt == 1:
            continue  # skip parent stations
        stop_positions.append((s["stop_lat"], s["stop_lon"]))

    # Build route_id -> set of shape_ids
    route_shapes = defaultdict(set)
    for t in trips.values():
        rid = t.get("route_id", "")
        sid = t.get("shape_id", "")
        if rid and sid:
            route_shapes[rid].add(sid)

    # Inverse: shape_id -> set of route_ids
    shape_routes = defaultdict(set)
    for rid, sids in route_shapes.items():
        for sid in sids:
            shape_routes[sid].add(rid)

    segments = {}
    shape_cumul = {}
    shape_coords_copy = {}

    for shape_id, coords in shapes.items():
        if len(coords) < 2:
            continue

        shape_coords_copy[shape_id] = coords

        # Build cumulative distance array
        cumul = [0.0]
        for i in range(1, len(coords)):
            d = _haversine(coords[i - 1][0], coords[i - 1][1],
                           coords[i][0], coords[i][1])
            cumul.append(cumul[-1] + d)
        shape_cumul[shape_id] = cumul

        total_length = cumul[-1]
        if total_length < seg_len * 0.5:
            continue  # shape too short

        n_segments = max(1, int(total_length / seg_len))
        rids = list(shape_routes.get(shape_id, []))

        for seg_idx in range(n_segments):
            start_m = seg_idx * seg_len
            end_m = min((seg_idx + 1) * seg_len, total_length)

            # Extract geometry points within this segment range
            seg_coords = _extract_segment_coords(coords, cumul, start_m, end_m)
            if len(seg_coords) < 2:
                continue

            # Check stop zone
            is_stop_zone = False
            for slat, slon in stop_positions:
                for clat, clon in seg_coords:
                    if _haversine(slat, slon, clat, clon) <= stop_radius:
                        is_stop_zone = True
                        break
                if is_stop_zone:
                    break

            seg_id = f"{shape_id}_seg_{seg_idx}"
            segments[seg_id] = {
                "shape_id": shape_id,
                "route_ids": rids,
                "geometry": seg_coords,  # [[lat, lon], ...]
                "stop_zone": is_stop_zone,
                "start_m": start_m,
                "end_m": end_m,
            }

    with traffic_store.lock:
        traffic_store.segments = segments
        traffic_store.shape_cumul = shape_cumul
        traffic_store.shape_coords = shape_coords_copy
        traffic_store.segment_count = len(segments)
        traffic_store.built = True
        # Reset states for new segments
        traffic_store.segment_states = {}
        traffic_store.vehicle_last_pos = {}

    print(f"Traffic: built {len(segments)} corridor segments from {len(shapes)} shapes")


def _extract_segment_coords(coords, cumul, start_m, end_m):
    """Return the sub-polyline of coords between start_m and end_m."""
    result = []

    for i in range(len(coords)):
        if cumul[i] >= start_m and cumul[i] <= end_m:
            result.append(coords[i])
        elif cumul[i] > end_m:
            break

    # Ensure at least start and end interpolated points
    if not result:
        # Find the segment spanning start_m
        for i in range(1, len(cumul)):
            if cumul[i] >= start_m:
                frac = (start_m - cumul[i - 1]) / max(cumul[i] - cumul[i - 1], 1e-9)
                lat = coords[i - 1][0] + frac * (coords[i][0] - coords[i - 1][0])
                lon = coords[i - 1][1] + frac * (coords[i][1] - coords[i - 1][1])
                result.append([lat, lon])
                break
        for i in range(1, len(cumul)):
            if cumul[i] >= end_m:
                frac = (end_m - cumul[i - 1]) / max(cumul[i] - cumul[i - 1], 1e-9)
                lat = coords[i - 1][0] + frac * (coords[i][0] - coords[i - 1][0])
                lon = coords[i - 1][1] + frac * (coords[i][1] - coords[i - 1][1])
                result.append([lat, lon])
                break

    return result


# ---------------------------------------------------------------------------
# GPS → shape projection
# ---------------------------------------------------------------------------

def _project_to_shape(lat, lon, shape_id, hint_seg_idx=None):
    """Project a GPS point onto a shape.

    Returns (distance_along_shape, segment_index_in_shape) or None.
    hint_seg_idx narrows the search window for performance.
    """
    coords = traffic_store.shape_coords.get(shape_id)
    cumul = traffic_store.shape_cumul.get(shape_id)
    if not coords or not cumul or len(coords) < 2:
        return None

    ref_lat = coords[0][0]
    ref_lon = coords[0][1]
    cos_ref = math.cos(math.radians(ref_lat))
    px, py = _latlon_to_local(lat, lon, ref_lat, ref_lon, cos_ref)

    best_dist = float("inf")
    best_along = 0.0

    # Determine search range
    if hint_seg_idx is not None:
        lo = max(0, hint_seg_idx - 5)
        hi = min(len(coords) - 1, hint_seg_idx + 6)
    else:
        lo = 0
        hi = len(coords) - 1

    for i in range(lo, hi):
        ax, ay = _latlon_to_local(coords[i][0], coords[i][1], ref_lat, ref_lon, cos_ref)
        bx, by = _latlon_to_local(coords[i + 1][0], coords[i + 1][1], ref_lat, ref_lon, cos_ref)
        dist, frac = _point_to_line_segment(px, py, ax, ay, bx, by)
        if dist < best_dist:
            best_dist = dist
            best_along = cumul[i] + frac * (cumul[i + 1] - cumul[i])

    # Reject if too far from shape (> 100m likely means wrong shape)
    if best_dist > 100:
        return None

    return best_along


def _distance_to_segment_id(shape_id, distance_along):
    """Convert a distance-along-shape to a segment_id."""
    seg_len = config.TRAFFIC_SEGMENT_LENGTH_M
    seg_idx = int(distance_along / seg_len)
    seg_id = f"{shape_id}_seg_{seg_idx}"
    if seg_id in traffic_store.segments:
        return seg_id
    return None


# ---------------------------------------------------------------------------
# Vehicle position processing
# ---------------------------------------------------------------------------

def process_vehicle_positions(vehicles, vehicle_trips):
    """Process a batch of vehicle positions and update traffic state.

    Called after each GTFS-RT poll.
    """
    if not traffic_store.built:
        return

    now = time.time()
    window = config.TRAFFIC_OBSERVATION_WINDOW_SEC

    with gtfs_store.lock:
        trips = dict(gtfs_store.trips)

    with traffic_store.lock:
        last_pos = traffic_store.vehicle_last_pos
        states = traffic_store.segment_states
        segments = traffic_store.segments

    new_observations = []  # (segment_id, vehicle_id, route_id, speed_kmh, timestamp)

    for v in vehicles:
        vid = v.get("vehicle_id", "")
        trip_id = v.get("trip_id", "")
        route_id = v.get("route_id", "")
        lat = v.get("lat")
        lon = v.get("lon")
        ts = v.get("timestamp", 0)

        if not vid or not trip_id or not lat or not lon or not ts:
            continue

        # Look up shape_id from trip
        trip = trips.get(trip_id)
        if not trip:
            continue
        shape_id = trip.get("shape_id", "")
        if not shape_id or shape_id not in traffic_store.shape_coords:
            continue

        # Project onto shape
        prev = last_pos.get(vid)
        hint = None
        if prev and prev.get("shape_id") == shape_id:
            # Estimate segment index from previous distance
            hint = int(prev.get("distance_along", 0) / max(config.TRAFFIC_SEGMENT_LENGTH_M, 1))

        result = _project_to_shape(lat, lon, shape_id, hint_seg_idx=hint)
        if result is None:
            continue

        distance_along = result
        seg_id = _distance_to_segment_id(shape_id, distance_along)

        # Calculate speed from previous position
        if prev and prev.get("shape_id") == shape_id and prev.get("timestamp", 0) > 0:
            dt = ts - prev["timestamp"]
            if 1 <= dt <= 300:  # 1s to 5min — reasonable interval
                dd = abs(distance_along - prev["distance_along"])
                speed_ms = dd / dt
                speed_kmh = speed_ms * 3.6

                # Sanity check: ignore unreasonable speeds (> 120 km/h for a bus)
                if 0 <= speed_kmh <= 120 and seg_id:
                    new_observations.append((seg_id, vid, route_id, speed_kmh, ts))

        # Update last position
        last_pos[vid] = {
            "lat": lat,
            "lon": lon,
            "timestamp": ts,
            "shape_id": shape_id,
            "segment_id": seg_id,
            "distance_along": distance_along,
        }

    # Apply observations and recalculate states
    with traffic_store.lock:
        traffic_store.vehicle_last_pos = last_pos

        # Add new observations
        for seg_id, vid, rid, speed, ts in new_observations:
            if seg_id not in states:
                states[seg_id] = {"observations": deque(maxlen=200)}
            states[seg_id]["observations"].append({
                "vehicle_id": vid,
                "route_id": rid,
                "speed_kmh": speed,
                "timestamp": ts,
            })

            # Update baseline
            _update_baseline(seg_id, speed, ts)

        # Recalculate segment states
        cutoff = now - window
        for seg_id in list(states.keys()):
            obs_deque = states[seg_id].get("observations")
            if not obs_deque:
                continue

            # Purge old observations
            while obs_deque and obs_deque[0]["timestamp"] < cutoff:
                obs_deque.popleft()

            if not obs_deque:
                states[seg_id] = {"observations": obs_deque}
                continue

            _recalculate_segment(seg_id, obs_deque, segments.get(seg_id), states)

        traffic_store.segment_states = states


def _recalculate_segment(seg_id, observations, segment_info, states):
    """Recalculate severity/confidence for one segment from its observations."""
    speeds = [o["speed_kmh"] for o in observations]
    vehicle_ids = {o["vehicle_id"] for o in observations}
    route_ids = {o["route_id"] for o in observations if o.get("route_id")}

    med_speed = median(speeds)
    n_vehicles = len(vehicle_ids)
    n_routes = len(route_ids)

    # Get baseline
    expected = _get_baseline_speed(seg_id)
    if expected and expected > 0:
        ratio = med_speed / expected
    else:
        # No baseline: use absolute thresholds
        # Normal urban bus speed ~20-35 km/h
        expected = 30.0
        ratio = med_speed / expected

    # Classify severity
    if ratio >= 0.85:
        severity = "none"
    elif ratio >= 0.65:
        severity = "low"
    elif ratio >= 0.45:
        severity = "medium"
    else:
        severity = "high"

    # Confidence based on evidence strength
    min_v = config.TRAFFIC_MIN_VEHICLES
    min_r = config.TRAFFIC_MIN_ROUTES

    if n_vehicles >= min_v and n_routes >= min_r:
        confidence = min(1.0, 0.5 + 0.1 * n_vehicles + 0.15 * n_routes)
    elif n_vehicles >= 2:
        confidence = 0.3 + 0.1 * n_vehicles
    else:
        confidence = 0.1

    # Stop-zone penalty
    if segment_info and segment_info.get("stop_zone"):
        confidence *= 0.3

    states[seg_id] = {
        "observations": observations,
        "severity": severity,
        "confidence": round(confidence, 2),
        "current_speed_kmh": round(med_speed, 1),
        "expected_speed_kmh": round(expected, 1) if expected else None,
        "speed_ratio": round(ratio, 2),
        "affected_vehicles": n_vehicles,
        "unique_routes": n_routes,
    }


# ---------------------------------------------------------------------------
# Baseline tracking
# ---------------------------------------------------------------------------

def _weekday_type(ts):
    dt = datetime.datetime.fromtimestamp(ts, tz=_TZ)
    wd = dt.weekday()
    if wd < 5:
        return "weekday"
    elif wd == 5:
        return "saturday"
    return "sunday"


def _update_baseline(segment_id, speed_kmh, timestamp):
    """Update running average baseline speed for a segment."""
    dt = datetime.datetime.fromtimestamp(timestamp, tz=_TZ)
    wt = _weekday_type(timestamp)
    hour = dt.hour
    key = f"{segment_id}:{wt}:{hour}"

    b = traffic_store.baseline_speeds.get(key, {"mean": 0.0, "count": 0})
    b["count"] += 1
    b["mean"] += (speed_kmh - b["mean"]) / b["count"]
    traffic_store.baseline_speeds[key] = b


def _get_baseline_speed(segment_id):
    """Get expected speed for current time of day."""
    now = datetime.datetime.now(tz=_TZ)
    wt = _weekday_type(now.timestamp())
    hour = now.hour
    key = f"{segment_id}:{wt}:{hour}"

    b = traffic_store.baseline_speeds.get(key)
    if b and b["count"] >= 5:
        return b["mean"]
    return None


def save_baseline():
    """Save baseline speeds to a JSON file for persistence across restarts."""
    path = config.TRAFFIC_BASELINE_FILE
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with traffic_store.lock:
            data = dict(traffic_store.baseline_speeds)
        with open(path, "w") as f:
            json.dump(data, f)
        print(f"Traffic: saved {len(data)} baseline entries to {path}")
    except Exception as e:
        print(f"Traffic: error saving baseline: {e}")


def load_baseline():
    """Load baseline speeds from JSON file if it exists."""
    path = config.TRAFFIC_BASELINE_FILE
    if not os.path.exists(path):
        return
    try:
        with open(path) as f:
            data = json.load(f)
        with traffic_store.lock:
            traffic_store.baseline_speeds = data
        print(f"Traffic: loaded {len(data)} baseline entries from {path}")
    except Exception as e:
        print(f"Traffic: error loading baseline: {e}")
