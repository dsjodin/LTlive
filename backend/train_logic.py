"""Train-specific vehicle processing logic.

Contains functions for building vehicle dicts from Trafikverket TrainPosition
data, annotating Oxyfi trains from TV announcements, and merging both sources.

Imported by app.py (SSE push, /api/vehicles) and api/debug_bp.py.
"""

import math
import time

import config
from store import _data, _lock
from stores.train_store import train_store


def _tv_operator_style(op: str, prod: str) -> tuple[str, str]:
    """Return (hex_color, long_name) for a train operator string."""
    op_l = op.lower()
    prod_l = prod.lower()
    if "mälartåg" in op_l or "mälartåg" in prod_l:
        return "005B99", "Mälartåg"
    if "sj" in op_l:
        return "D4004C", "SJ"
    if "arriva" in op_l or "tib" in prod_l or "bergslagen" in prod_l:
        return "E87722", "Tåg i Bergslagen"
    if "snälltåget" in op_l:
        return "1A1A1A", "Snälltåget"
    if "mtr" in op_l:
        return "007BC0", "MTR"
    return "555555", op.title() or "Tåg"


def _tv_trains_from_positions() -> list:
    """Build vehicle-like dicts from Trafikverket TrainPosition data.

    Includes every train whose GPS position is within
    config.TV_POSITION_RADIUS_KM of the configured center point
    (default: Örebro C).  Operator/colour is resolved first from
    tv_announcements (most accurate) and falls back to the
    InformationOwner field in the TrainPosition record itself.
    Positions older than 10 minutes are discarded.
    """
    with _lock:
        tv_positions = list(_data.get("tv_positions", []))
        tv_announcements = dict(_data.get("tv_announcements", {}))

    # Build train_number → {operator, product} from announcement data (preferred source)
    ann_info: dict[str, dict] = {}
    for bucket in tv_announcements.values():
        for entry in bucket.get("departures", []) + bucket.get("arrivals", []):
            tn = entry.get("train_number", "")
            if tn and tn not in ann_info:
                ann_info[tn] = {
                    "operator": entry.get("operator", ""),
                    "product": entry.get("product", ""),
                }

    # Persist operator info so it survives announcement expiry
    for tn, info in ann_info.items():
        if info["operator"] or info["product"]:
            train_store.operator_cache[tn] = info

    center_lat = config.TV_POSITION_CENTER_LAT
    center_lon = config.TV_POSITION_CENTER_LON
    radius_m = config.TV_POSITION_RADIUS_KM * 1000
    cos_clat = math.cos(math.radians(center_lat))

    cutoff = int(time.time()) - 600  # discard positions older than 10 min

    # Deduplicate: keep only the newest position per train number
    newest: dict[str, dict] = {}
    for pos in tv_positions:
        tn = pos.get("train_number", "")
        if not tn:
            continue
        ts = pos.get("timestamp") or 0
        if ts and ts < cutoff:
            continue
        if tn not in newest or (ts or 0) > (newest[tn].get("timestamp") or 0):
            newest[tn] = pos

    result = []
    for tn, pos in newest.items():
        ts = pos.get("timestamp") or 0

        # Radius filter
        plat, plon = pos["lat"], pos["lon"]
        dlat = math.radians(plat - center_lat)
        dlon = math.radians(plon - center_lon)
        a = math.sin(dlat / 2) ** 2 + cos_clat * math.cos(math.radians(plat)) * math.sin(dlon / 2) ** 2
        dist_m = 2 * 6_371_000 * math.asin(math.sqrt(max(0.0, a)))
        if dist_m > radius_m:
            continue

        # Resolve operator: announcement data first, then cache, then fallback
        if tn in ann_info:
            op = ann_info[tn]["operator"]
            prod = ann_info[tn]["product"]
        elif tn in train_store.operator_cache:
            op = train_store.operator_cache[tn]["operator"]
            prod = train_store.operator_cache[tn]["product"]
        else:
            op = pos.get("operator", "")
            prod = ""

        color, long_name = _tv_operator_style(op, prod)

        result.append({
            "id": f"tv_{tn}",
            "vehicle_id": f"tv_{tn}",
            "label": tn,
            "lat": plat,
            "lon": plon,
            "bearing": pos.get("bearing"),
            "speed": pos.get("speed"),
            "current_status": "I trafik",
            "current_stop_id": "",
            "trip_id": "",
            "route_id": "",
            "direction_id": None,
            "start_date": "",
            "timestamp": ts or int(time.time()),
            "vehicle_type": "train",
            "route_short_name": tn,
            "route_long_name": long_name,
            "route_color": color,
            "route_text_color": "FFFFFF",
            "trip_headsign": "",
            "next_stop_name": "",
            "next_stop_platform": "",
        })
    return result


def _annotate_oxyfi_from_announcements(trains: list) -> list:
    """For Oxyfi trains still missing tv_service_number, try to identify them
    by finding the nearest configured station and matching the TV announcement
    whose realtime/scheduled time is closest to now.

    This is a fallback for when TV TrainPosition data is unavailable.  It works
    purely from announcements (departures + arrivals), which are always fetched.
    """
    with _lock:
        tv_ann = _data.get("tv_announcements", {})
        tv_stations = _data.get("tv_stations", {})

    if not tv_ann:
        return trains

    # Build station anchors using authoritative Trafikverket WGS84 coordinates.
    station_anchors: list[tuple] = []
    for loc_sig in tv_ann:
        st = tv_stations.get(loc_sig, {})
        lat, lon = st.get("lat"), st.get("lon")
        if lat and lon:
            station_anchors.append((loc_sig, float(lat), float(lon)))

    if not station_anchors:
        return trains

    now = int(time.time())
    WINDOW = 1200  # ±20 min — covers trains currently between stops

    # Phase 1: collect all (time_diff, oxyfi_index, train_number, sched_time) candidates
    candidates = []
    for idx, v in enumerate(trains):
        if v.get("tv_service_number") or (v.get("vehicle_id") or "").startswith("tv_"):
            continue
        o_lat, o_lon = v.get("lat"), v.get("lon")
        if not (o_lat and o_lon):
            continue

        # Nearest configured station
        best_dist = float("inf")
        nearest_loc_sig = None
        for loc_sig, s_lat, s_lon in station_anchors:
            dlat = math.radians(s_lat - o_lat)
            dlon = math.radians(s_lon - o_lon)
            a = (math.sin(dlat / 2) ** 2
                 + math.cos(math.radians(o_lat)) * math.cos(math.radians(s_lat))
                 * math.sin(dlon / 2) ** 2)
            dist = 6_371_000 * 2 * math.asin(math.sqrt(max(0.0, a)))
            if dist < best_dist:
                best_dist = dist
                nearest_loc_sig = loc_sig

        if not nearest_loc_sig:
            continue

        ann_bucket = tv_ann.get(nearest_loc_sig, {})
        for entry in ann_bucket.get("departures", []) + ann_bucket.get("arrivals", []):
            op = (entry.get("operator") or "").lower()
            pr = (entry.get("product") or "").lower()
            if not ("arriva" in op or "bergslagen" in pr or "tib" in pr):
                continue
            rt = entry.get("realtime_time") or entry.get("scheduled_time")
            if rt is None:
                continue
            diff = abs(rt - now)
            if diff <= WINDOW:
                candidates.append((diff, idx,
                                   entry.get("train_number", ""),
                                   entry.get("scheduled_time", 0)))

    # Phase 2: greedy exclusive assignment — sort by time_diff (best match first).
    # Each (train_number, scheduled_time) key can only be assigned to one Oxyfi train.
    candidates.sort()
    used_keys: set = set()
    assigned: dict = {}  # oxyfi_index -> train_number
    for diff, idx, tn, sched_t in candidates:
        ann_key = (tn, sched_t)
        if idx not in assigned and ann_key not in used_keys:
            assigned[idx] = tn
            used_keys.add(ann_key)

    return [
        ({**v, "tv_service_number": assigned[i]} if i in assigned else v)
        for i, v in enumerate(trains)
    ]


def _merge_trains(oxyfi_trains: list, tv_trains: list) -> list:
    """Merge Oxyfi and TV trains.

    Pass 1: exact label match (both sides have the same advertised train number).
    Pass 2: position proximity — Oxyfi sends rolling-stock IDs (9xxx) while TV uses
    service numbers (8xxx), so the same physical train will never match on label alone.
    If an unmatched Oxyfi train is within 300 m of an unmatched TV train we treat them
    as the same physical train: keep Oxyfi's GPS position, add TV's service number as
    `tv_service_number` so the diag can display both IDs, and suppress the TV duplicate.
    """
    matched_tv_ids: set = set()
    result: list = []

    for oxyfi_train in oxyfi_trains:
        o_label = oxyfi_train.get("label", "")
        # Pass 1: exact label
        tv_exact = next((t for t in tv_trains if t.get("label", "") == o_label), None)
        if tv_exact:
            matched_tv_ids.add(tv_exact["vehicle_id"])
            result.append({**oxyfi_train, "tv_service_number": tv_exact["label"]})
            continue

        # Pass 2: position + bearing proximity.
        o_lat, o_lon = oxyfi_train.get("lat"), oxyfi_train.get("lon")
        o_bearing = oxyfi_train.get("bearing")
        best_tv = None
        best_dist = float("inf")
        if o_lat and o_lon:
            for t in tv_trains:
                if t["vehicle_id"] in matched_tv_ids:
                    continue
                t_lat, t_lon = t.get("lat"), t.get("lon")
                if not (t_lat and t_lon):
                    continue
                dlat = math.radians(t_lat - o_lat)
                dlon = math.radians(t_lon - o_lon)
                a = (math.sin(dlat / 2) ** 2
                     + math.cos(math.radians(o_lat)) * math.cos(math.radians(t_lat))
                     * math.sin(dlon / 2) ** 2)
                dist = 6_371_000 * 2 * math.asin(math.sqrt(max(0.0, a)))
                if dist >= 300:
                    continue
                t_bearing = t.get("bearing")
                if o_bearing is not None and t_bearing is not None:
                    diff = abs((o_bearing - t_bearing + 180) % 360 - 180)
                    if diff > 45:
                        continue
                if dist < best_dist:
                    best_dist = dist
                    best_tv = t

        if best_tv:
            matched_tv_ids.add(best_tv["vehicle_id"])
            result.append({**oxyfi_train, "tv_service_number": best_tv["label"]})
        else:
            result.append(oxyfi_train)

    # Add TV trains not matched to any Oxyfi vehicle
    result += [t for t in tv_trains if t["vehicle_id"] not in matched_tv_ids]
    return result
