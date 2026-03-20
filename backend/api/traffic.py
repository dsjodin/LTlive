"""Traffic inference API — serves inferred road traffic impact as GeoJSON."""

import time

from flask import Blueprint, jsonify, request

import config
from stores.traffic_store import traffic_store

bp = Blueprint("traffic", __name__)

_SEVERITY_ORDER = {"none": 0, "low": 1, "medium": 2, "high": 3}


@bp.route("/api/traffic")
def get_traffic():
    """Return GeoJSON FeatureCollection of corridor segments with traffic state."""
    min_confidence = float(request.args.get("min_confidence", "0.3"))
    min_severity = request.args.get("min_severity", "low")
    min_sev_val = _SEVERITY_ORDER.get(min_severity, 1)

    features = []

    with traffic_store.lock:
        segments = traffic_store.segments
        states = traffic_store.segment_states

        for seg_id, seg in segments.items():
            state = states.get(seg_id)
            if not state or "severity" not in state:
                continue

            sev_val = _SEVERITY_ORDER.get(state.get("severity", "none"), 0)
            if sev_val < min_sev_val:
                continue
            if state.get("confidence", 0) < min_confidence:
                continue

            coords = [[pt[1], pt[0]] for pt in seg["geometry"]]
            if len(coords) < 2:
                continue

            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": coords,
                },
                "properties": {
                    "segment_id": seg_id,
                    "severity": state.get("severity", "none"),
                    "confidence": state.get("confidence", 0),
                    "current_speed_kmh": state.get("current_speed_kmh"),
                    "expected_speed_kmh": state.get("expected_speed_kmh"),
                    "speed_ratio": state.get("speed_ratio"),
                    "affected_vehicles": state.get("affected_vehicles", 0),
                    "unique_routes": state.get("unique_routes", 0),
                    "delay_onset_count": state.get("delay_onset_count", 0),
                    "stop_zone": seg.get("stop_zone", False),
                    "signal_zone": seg.get("signal_zone", False),
                    "terminal_zone": seg.get("terminal_zone", False),
                },
            })

    return jsonify({
        "type": "FeatureCollection",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "features": features,
        "count": len(features),
    })


@bp.route("/api/traffic/summary")
def get_traffic_summary():
    """Return summary statistics for the traffic layer."""
    with traffic_store.lock:
        severity_counts = {"none": 0, "low": 0, "medium": 0, "high": 0}
        for s in traffic_store.segment_states.values():
            sev = s.get("severity", "none")
            if sev in severity_counts:
                severity_counts[sev] += 1

    return jsonify({
        "total_segments": traffic_store.segment_count,
        "signal_zones": traffic_store.signal_zone_count,
        "severity": severity_counts,
        "active": severity_counts["low"] + severity_counts["medium"] + severity_counts["high"],
    })


@bp.route("/api/traffic/debug")
def get_traffic_debug():
    """Internal diagnostics for the traffic inference system."""
    if not config.ENABLE_DEBUG_ENDPOINTS:
        return jsonify({"error": "debug endpoints disabled"}), 403

    with traffic_store.lock:
        n_segments = traffic_store.segment_count
        n_active = sum(
            1 for s in traffic_store.segment_states.values()
            if s.get("severity") and s["severity"] != "none"
        )
        n_vehicles_tracked = len(traffic_store.vehicle_last_pos)
        n_baseline = len(traffic_store.baseline_speeds)
        n_signals = traffic_store.signal_zone_count
        n_terminals = len(traffic_store.terminal_positions)

        severity_counts = {"none": 0, "low": 0, "medium": 0, "high": 0}
        total_delay_onsets = 0
        for s in traffic_store.segment_states.values():
            sev = s.get("severity", "none")
            severity_counts[sev] = severity_counts.get(sev, 0) + 1
            total_delay_onsets += s.get("delay_onset_count", 0)

        n_stop_zones = sum(1 for s in traffic_store.segments.values() if s.get("stop_zone"))
        n_signal_zones = sum(1 for s in traffic_store.segments.values() if s.get("signal_zone"))
        n_terminal_zones = sum(1 for s in traffic_store.segments.values() if s.get("terminal_zone"))

    return jsonify({
        "built": traffic_store.built,
        "total_segments": n_segments,
        "segments_with_data": len(traffic_store.segment_states),
        "active_incidents": n_active,
        "vehicles_tracked": n_vehicles_tracked,
        "baseline_entries": n_baseline,
        "severity_distribution": severity_counts,
        "zones": {
            "stop_zone_segments": n_stop_zones,
            "signal_zone_segments": n_signal_zones,
            "terminal_zone_segments": n_terminal_zones,
            "osm_signal_points": n_signals,
            "terminal_stops": n_terminals,
        },
        "delay_onsets_in_window": total_delay_onsets,
    })
