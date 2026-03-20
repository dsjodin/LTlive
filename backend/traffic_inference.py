"""Infer real-time road traffic impact from bus movement.

Buses act as floating probes.  Repeated abnormal slowdowns at the same
location across multiple vehicles indicate traffic-related problems.

Pipeline:
  1. build_segments()  — called once after GTFS static loads
  2. process_vehicle_positions()  — called after each RT poll
  3. Results read via traffic_store.segment_states → /api/traffic

Phase 2 additions:
  - Delay onset detection (from TripUpdates delay growth between stops)
  - Signal zone filtering (from OSM traffic_signals)
  - Terminal zone filtering (first/last stop of trips)
  - Combined evidence scoring
"""

import datetime
import json
import math
import os
import threading
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
    """Project point P onto line segment AB (flat coordinates).

    Returns (distance_to_line, fraction_along_AB).
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
    """Kick off segment building in a background thread (non-blocking)."""
    threading.Thread(target=_build_segments_worker, daemon=True,
                     name="traffic-build").start()


def _build_segments_worker():
    """Split every GTFS shape into ~100 m corridor segments.

    Runs in a background thread so it never blocks GTFS loading.
    Uses a grid spatial index to avoid O(n_stops × n_segments) haversine calls.
    """
    try:
        _do_build_segments()
    except Exception as exc:
        import traceback
        print(f"Traffic: build_segments failed: {exc}")
        traceback.print_exc()


def _build_fine_grid(positions, cell_deg):
    """Map each position to a grid cell; returns dict cell→[(lat,lon)]."""
    grid = defaultdict(list)
    for lat, lon in positions:
        grid[(int(lat / cell_deg), int(lon / cell_deg))].append((lat, lon))
    return grid


def _midpoint(seg_coords):
    """Return (lat, lon) midpoint of a segment."""
    n = len(seg_coords)
    return (
        sum(c[0] for c in seg_coords) / n,
        sum(c[1] for c in seg_coords) / n,
    )


def _in_zone_fast(mlat, mlon, grid, radius_m, cell_deg):
    """O(1) zone check using fine grid + haversine only on nearby stops.

    Uses the segment midpoint instead of all coords — precise enough
    because stop_radius (35 m) << segment length (100 m).
    """
    extra = max(1, int(radius_m / (cell_deg * 111_320)) + 1)
    ci = int(mlat / cell_deg)
    cj = int(mlon / cell_deg)
    for di in range(-extra, extra + 1):
        for dj in range(-extra, extra + 1):
            for slat, slon in grid.get((ci + di, cj + dj), []):
                if _haversine(slat, slon, mlat, mlon) <= radius_m:
                    return True
    return False


def _do_build_segments():
    with gtfs_store.lock:
        shapes = dict(gtfs_store.shapes)
        stops  = dict(gtfs_store.stops)
        trips  = dict(gtfs_store.trips)

    seg_len     = config.TRAFFIC_SEGMENT_LENGTH_M
    stop_radius = config.TRAFFIC_STOP_ZONE_RADIUS_M

    # Fine grid (0.0003° ≈ 33 m/cell) — nearly zero haversine calls per segment
    _CELL = 0.0003

    stop_positions = [
        (s["stop_lat"], s["stop_lon"])
        for s in stops.values()
        if s.get("location_type", 0) != 1
    ]
    stop_fine_grid = _build_fine_grid(stop_positions, _CELL)

    terminal_positions = set()
    _identify_terminals(trips, stops, terminal_positions)
    term_fine_grid = _build_fine_grid(list(terminal_positions), _CELL)

    # shape_id → set of route_ids
    shape_routes = defaultdict(set)
    for t in trips.values():
        rid = t.get("route_id", "")
        sid = t.get("shape_id", "")
        if rid and sid:
            shape_routes[sid].add(rid)

    segments        = {}
    shape_cumul     = {}
    shape_coords_copy = {}

    t0 = time.time()
    shape_list = list(shapes.items())
    n_shapes   = len(shape_list)
    _t_cumul = _t_bucket = _t_zone = _t_dict = 0.0

    for shape_num, (shape_id, coords) in enumerate(shape_list):
        if shape_num % 100 == 0 and shape_num > 0:
            print(f"Traffic: building segments {shape_num}/{n_shapes} "
                  f"({len(segments)} segs, {time.time()-t0:.1f}s) "
                  f"cumul={_t_cumul:.2f}s bucket={_t_bucket:.2f}s "
                  f"zone={_t_zone:.2f}s dict={_t_dict:.2f}s")

        if len(coords) < 2:
            continue

        shape_coords_copy[shape_id] = coords

        # Build cumulative distances in one pass
        _tc = time.time()
        cumul = [0.0]
        for i in range(1, len(coords)):
            d = _haversine(coords[i-1][0], coords[i-1][1],
                           coords[i][0],   coords[i][1])
            cumul.append(cumul[-1] + d)
        shape_cumul[shape_id] = cumul
        _t_cumul += time.time() - _tc

        total_length = cumul[-1]
        if total_length < seg_len * 0.5:
            continue

        n_segs = max(1, int(total_length / seg_len))
        rids   = list(shape_routes.get(shape_id, []))

        # Single pass: bucket each shape point into its segment
        _tb = time.time()
        seg_buckets = [[] for _ in range(n_segs)]
        for i, pt in enumerate(coords):
            bucket = min(int(cumul[i] / seg_len), n_segs - 1)
            seg_buckets[bucket].append(pt)
        _t_bucket += time.time() - _tb

        for seg_idx in range(n_segs):
            seg_coords = seg_buckets[seg_idx]
            if len(seg_coords) < 2:
                continue

            # Midpoint-only zone check via fine grid — ~0 haversine calls/segment
            _tz = time.time()
            mlat, mlon = _midpoint(seg_coords)
            is_stop_zone = _in_zone_fast(mlat, mlon, stop_fine_grid, stop_radius, _CELL)
            is_terminal  = _in_zone_fast(mlat, mlon, term_fine_grid, 60, _CELL)
            _t_zone += time.time() - _tz

            _td = time.time()
            seg_id = f"{shape_id}_seg_{seg_idx}"
            segments[seg_id] = {
                "shape_id":      shape_id,
                "route_ids":     rids,
                "geometry":      seg_coords,
                "stop_zone":     is_stop_zone,
                "signal_zone":   False,
                "terminal_zone": is_terminal,
                "start_m":       seg_idx * seg_len,
                "end_m":         min((seg_idx + 1) * seg_len, total_length),
            }
            _t_dict += time.time() - _td

    with traffic_store.lock:
        traffic_store.segments        = segments
        traffic_store.shape_cumul     = shape_cumul
        traffic_store.shape_coords    = shape_coords_copy
        traffic_store.segment_count   = len(segments)
        traffic_store.terminal_positions = terminal_positions
        traffic_store.built           = True
        traffic_store.segment_states  = {}
        traffic_store.vehicle_last_pos = {}
        traffic_store.vehicle_last_delay = {}
        traffic_store.delay_onset_events = {}

    n_stop = sum(1 for s in segments.values() if s["stop_zone"])
    n_term = sum(1 for s in segments.values() if s["terminal_zone"])
    print(f"Traffic: built {len(segments)} segments ({n_stop} stop zones, "
          f"{n_term} terminal zones) from {len(shapes)} shapes")

    # Fetch signal zones in background (non-blocking)
    threading.Thread(target=_fetch_signal_zones, daemon=True,
                     name="osm-signals").start()


def _identify_terminals(trips, stops, terminal_positions):
    """Find first and last stop of each trip from stop_times.txt."""
    try:
        from gtfs_loader import _read_csv
        trip_first = {}  # trip_id -> (min_seq, stop_id)
        trip_last = {}   # trip_id -> (max_seq, stop_id)

        for row in _read_csv("stop_times.txt"):
            tid = row["trip_id"]
            seq = int(row.get("stop_sequence", 0))
            sid = row["stop_id"]

            if tid not in trip_first or seq < trip_first[tid][0]:
                trip_first[tid] = (seq, sid)
            if tid not in trip_last or seq > trip_last[tid][0]:
                trip_last[tid] = (seq, sid)

        seen_stop_ids = set()
        for mapping in (trip_first, trip_last):
            for _, (_, stop_id) in mapping.items():
                seen_stop_ids.add(stop_id)

        for sid in seen_stop_ids:
            s = stops.get(sid)
            if s:
                terminal_positions.add((s["stop_lat"], s["stop_lon"]))

        print(f"Traffic: identified {len(terminal_positions)} terminal positions")
    except Exception as e:
        print(f"Traffic: could not identify terminals: {e}")


def _check_zone(seg_coords, positions, radius_m):
    """Check if any segment coordinate is within radius of any position."""
    for slat, slon in positions:
        for clat, clon in seg_coords:
            if _haversine(slat, slon, clat, clon) <= radius_m:
                return True
    return False


def _extract_segment_coords(coords, cumul, start_m, end_m):
    """Return the sub-polyline of coords between start_m and end_m."""
    result = []

    for i in range(len(coords)):
        if cumul[i] >= start_m and cumul[i] <= end_m:
            result.append(coords[i])
        elif cumul[i] > end_m:
            break

    if not result:
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
# OSM signal zone fetching
# ---------------------------------------------------------------------------

_SIGNAL_ZONE_RADIUS_M = 30


def _fetch_signal_zones():
    """Fetch traffic signal positions from OSM Overpass API."""
    try:
        import requests

        # Bounding box for Örebro area (with generous margin)
        lat_c = config.MAP_CENTER_LAT
        lon_c = config.MAP_CENTER_LON
        margin = 0.15  # ~15 km
        bbox = f"{lat_c - margin},{lon_c - margin},{lat_c + margin},{lon_c + margin}"

        query = f'[out:json][timeout:15];node["highway"="traffic_signals"]({bbox});out;'
        resp = requests.post(
            "https://overpass-api.de/api/interpreter",
            data={"data": query},
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()

        signal_zones = []
        for element in data.get("elements", []):
            if element.get("type") == "node":
                signal_zones.append({
                    "lat": element["lat"],
                    "lon": element["lon"],
                    "radius_m": _SIGNAL_ZONE_RADIUS_M,
                    "source": "osm",
                })

        # Mark segments that overlap signal zones
        with traffic_store.lock:
            traffic_store.signal_zones = signal_zones
            traffic_store.signal_zone_count = len(signal_zones)

            signal_positions = [(s["lat"], s["lon"]) for s in signal_zones]
            for seg_id, seg in traffic_store.segments.items():
                if _check_zone(seg["geometry"], signal_positions, _SIGNAL_ZONE_RADIUS_M):
                    seg["signal_zone"] = True

        n_signal_segs = sum(1 for s in traffic_store.segments.values() if s.get("signal_zone"))
        print(f"Traffic: loaded {len(signal_zones)} signal zones from OSM, "
              f"{n_signal_segs} segments marked")

    except Exception as e:
        print(f"Traffic: could not fetch OSM signal zones: {e}")


# ---------------------------------------------------------------------------
# GPS → shape projection
# ---------------------------------------------------------------------------

def _project_to_shape(lat, lon, shape_id, hint_seg_idx=None):
    """Project a GPS point onto a shape.

    Returns distance_along_shape or None.
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
# Vehicle position processing (main pipeline)
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
        last_delay = traffic_store.vehicle_last_delay
        states = traffic_store.segment_states
        segments = traffic_store.segments
        delay_events = traffic_store.delay_onset_events

    new_observations = []  # (segment_id, vehicle_id, route_id, speed_kmh, timestamp)
    new_delay_onsets = []  # (segment_id, vehicle_id, delta_delay, timestamp)

    for v in vehicles:
        vid = v.get("vehicle_id", "")
        trip_id = v.get("trip_id", "")
        route_id = v.get("route_id", "")
        lat = v.get("lat")
        lon = v.get("lon")
        ts = v.get("timestamp", 0)
        delay_sec = v.get("delay_seconds")

        if not vid or not trip_id or not lat or not lon or not ts:
            continue

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
            hint = int(prev.get("distance_along", 0) / max(config.TRAFFIC_SEGMENT_LENGTH_M, 1))

        result = _project_to_shape(lat, lon, shape_id, hint_seg_idx=hint)
        if result is None:
            continue

        distance_along = result
        seg_id = _distance_to_segment_id(shape_id, distance_along)

        # Speed from consecutive positions
        if prev and prev.get("shape_id") == shape_id and prev.get("timestamp", 0) > 0:
            dt = ts - prev["timestamp"]
            if 1 <= dt <= 300:
                dd = abs(distance_along - prev["distance_along"])
                speed_ms = dd / dt
                speed_kmh = speed_ms * 3.6

                if 0 <= speed_kmh <= 120 and seg_id:
                    new_observations.append((seg_id, vid, route_id, speed_kmh, ts))

        # Delay onset detection
        if delay_sec is not None and seg_id:
            prev_delay = last_delay.get(vid)
            if prev_delay is not None:
                delta = delay_sec - prev_delay
                if delta >= 60:  # 60s delay growth → delay onset
                    new_delay_onsets.append((seg_id, vid, delta, ts))
            last_delay[vid] = delay_sec

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
        traffic_store.vehicle_last_delay = last_delay

        # Add speed observations
        for seg_id, vid, rid, speed, ts in new_observations:
            if seg_id not in states:
                states[seg_id] = {"observations": deque(maxlen=200)}
            states[seg_id]["observations"].append({
                "vehicle_id": vid,
                "route_id": rid,
                "speed_kmh": speed,
                "timestamp": ts,
            })
            _update_baseline(seg_id, speed, ts)

        # Add delay onset events
        for seg_id, vid, delta, ts in new_delay_onsets:
            if seg_id not in delay_events:
                delay_events[seg_id] = deque(maxlen=50)
            delay_events[seg_id].append({
                "vehicle_id": vid,
                "delta_delay": delta,
                "timestamp": ts,
            })

        # Recalculate all segment states
        cutoff = now - window
        for seg_id in list(states.keys()):
            obs_deque = states[seg_id].get("observations")
            if not obs_deque:
                continue

            while obs_deque and obs_deque[0]["timestamp"] < cutoff:
                obs_deque.popleft()

            # Also purge old delay events
            d_events = delay_events.get(seg_id)
            if d_events:
                while d_events and d_events[0]["timestamp"] < cutoff:
                    d_events.popleft()

            if not obs_deque:
                states[seg_id] = {"observations": obs_deque}
                continue

            _recalculate_segment(seg_id, obs_deque,
                                 segments.get(seg_id),
                                 delay_events.get(seg_id),
                                 states)

        traffic_store.segment_states = states
        traffic_store.delay_onset_events = delay_events


# ---------------------------------------------------------------------------
# Segment state calculation with combined evidence
# ---------------------------------------------------------------------------

def _recalculate_segment(seg_id, observations, segment_info, delay_onsets, states):
    """Recalculate severity/confidence for one segment using combined evidence."""
    speeds = [o["speed_kmh"] for o in observations]
    vehicle_ids = {o["vehicle_id"] for o in observations}
    route_ids = {o["route_id"] for o in observations if o.get("route_id")}

    med_speed = median(speeds)
    n_vehicles = len(vehicle_ids)
    n_routes = len(route_ids)

    # Count delay onset events
    delay_onset_count = 0
    if delay_onsets:
        delay_onset_count = len(delay_onsets)

    # Get baseline
    expected = _get_baseline_speed(seg_id)
    if expected and expected > 0:
        ratio = med_speed / expected
    else:
        expected = 30.0
        ratio = med_speed / expected

    # --- Severity classification ---
    if ratio >= 0.85:
        severity = "none"
    elif ratio >= 0.65:
        severity = "low"
    elif ratio >= 0.45:
        severity = "medium"
    else:
        severity = "high"

    # --- Combined confidence scoring ---
    # Base confidence from vehicle/route count
    min_v = config.TRAFFIC_MIN_VEHICLES
    min_r = config.TRAFFIC_MIN_ROUTES

    if n_vehicles >= min_v and n_routes >= min_r:
        confidence = min(1.0, 0.5 + 0.1 * n_vehicles + 0.15 * n_routes)
    elif n_vehicles >= 2:
        confidence = 0.3 + 0.1 * n_vehicles
    else:
        confidence = 0.1

    # Boost from delay onset evidence
    if delay_onset_count >= 2:
        confidence = min(1.0, confidence + 0.2)
    elif delay_onset_count >= 1:
        confidence = min(1.0, confidence + 0.1)

    # Boost from low speed ratio (stronger slowdown = more likely real)
    if ratio < 0.3 and n_vehicles >= 2:
        confidence = min(1.0, confidence + 0.1)

    # --- False positive penalties ---
    is_stop = segment_info and segment_info.get("stop_zone", False)
    is_signal = segment_info and segment_info.get("signal_zone", False)
    is_terminal = segment_info and segment_info.get("terminal_zone", False)

    # Terminal zones: strong penalty, likely layover/turnaround
    if is_terminal:
        confidence *= 0.15

    # Stop zones: penalty (boarding/alighting, not traffic)
    if is_stop:
        confidence *= 0.3

    # Signal zones: moderate penalty (short stops expected)
    if is_signal and not is_stop:
        confidence *= 0.4

    # Single vehicle: cap severity at "low" regardless
    if n_vehicles < 2 and severity in ("medium", "high"):
        severity = "low"

    states[seg_id] = {
        "observations": observations,
        "severity": severity,
        "confidence": round(confidence, 2),
        "current_speed_kmh": round(med_speed, 1),
        "expected_speed_kmh": round(expected, 1) if expected else None,
        "speed_ratio": round(ratio, 2),
        "affected_vehicles": n_vehicles,
        "unique_routes": n_routes,
        "delay_onset_count": delay_onset_count,
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
