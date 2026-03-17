"""Trafikverket Open Data API integration.

Fetches TrainAnnouncement (departure/arrival boards with train numbers)
and TrainPosition (real-time GPS) from api.trafikinfo.trafikverket.se.
"""
import logging
import re
import time
from datetime import datetime, timezone, timedelta

import requests

import config

log = logging.getLogger(__name__)

_TV_URL = "https://api.trafikinfo.trafikverket.se/v2/data.json"
_SESSION = requests.Session()


def _post(xml_body: str) -> dict:
    resp = _SESSION.post(
        _TV_URL,
        data=xml_body.encode("utf-8"),
        headers={"Content-Type": "application/xml"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def _ts_to_unix(ts_str: str) -> int | None:
    """Parse ISO-8601 timestamp like '2026-03-13T23:30:00.000+01:00' → Unix int."""
    if not ts_str:
        return None
    # Strip milliseconds and parse
    ts_str = re.sub(r"\.\d+", "", ts_str)
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S"):
        try:
            dt = datetime.strptime(ts_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone(timedelta(hours=1)))
            return int(dt.timestamp())
        except ValueError:
            continue
    return None


def fetch_train_stations() -> dict:
    """Fetch all train stations → {LocationSignature: {name, lat, lon}}."""
    if not config.TRAFIKVERKET_API_KEY:
        return {}
    xml = f"""<REQUEST>
  <LOGIN authenticationkey="{config.TRAFIKVERKET_API_KEY}" />
  <QUERY objecttype="TrainStation" schemaversion="1.0" limit="10000">
    <FILTER>
      <EQ name="Advertised" value="true" />
    </FILTER>
    <INCLUDE>LocationSignature</INCLUDE>
    <INCLUDE>AdvertisedLocationName</INCLUDE>
    <INCLUDE>Geometry.WGS84</INCLUDE>
  </QUERY>
</REQUEST>"""
    try:
        data = _post(xml)
        result = {}
        for st in data["RESPONSE"]["RESULT"][0].get("TrainStation", []):
            sig = st.get("LocationSignature", "")
            name = st.get("AdvertisedLocationName", "")
            wgs = st.get("Geometry", {}).get("WGS84", "")
            lat = lon = None
            m = re.search(r"POINT\s*\(([0-9.]+)\s+([0-9.]+)\)", wgs)
            if m:
                lon, lat = float(m.group(1)), float(m.group(2))
            result[sig] = {"name": name, "lat": lat, "lon": lon}
        log.info("Loaded %d train stations from Trafikverket", len(result))
        return result
    except Exception as exc:
        log.warning("TrainStation fetch failed: %s", exc)
        return {}


def fetch_announcements(location_signatures: list[str], minutes_ahead: int = 120) -> dict:
    """Fetch TrainAnnouncement for given LocationSignatures.

    Returns {location_sig: {"departures": [...], "arrivals": [...]}}.
    Each entry has:
        train_number, scheduled_time, estimated_time, is_realtime,
        track, destination_sig, destination_name (filled in by caller),
        origin_sig, canceled, product, operator, deviation
    """
    if not config.TRAFIKVERKET_API_KEY or not location_signatures:
        return {}

    # Build OR filter for multiple stations
    if len(location_signatures) == 1:
        loc_filter = f'<EQ name="LocationSignature" value="{location_signatures[0]}" />'
    else:
        parts = "".join(
            f'<EQ name="LocationSignature" value="{s}" />'
            for s in location_signatures
        )
        loc_filter = f"<OR>{parts}</OR>"

    xml = f"""<REQUEST>
  <LOGIN authenticationkey="{config.TRAFIKVERKET_API_KEY}" />
  <QUERY objecttype="TrainAnnouncement" schemaversion="1.9"
         orderby="AdvertisedTimeAtLocation" limit="500">
    <FILTER>
      <AND>
        {loc_filter}
        <EQ name="Advertised" value="true" />
        <GT name="AdvertisedTimeAtLocation" value="$dateadd(-0:05:00)" />
        <LT name="AdvertisedTimeAtLocation" value="$dateadd({minutes_ahead // 60}:{minutes_ahead % 60:02d}:00)" />
      </AND>
    </FILTER>
    <INCLUDE>AdvertisedTrainIdent</INCLUDE>
    <INCLUDE>ActivityType</INCLUDE>
    <INCLUDE>AdvertisedTimeAtLocation</INCLUDE>
    <INCLUDE>EstimatedTimeAtLocation</INCLUDE>
    <INCLUDE>PlannedEstimatedTimeAtLocation</INCLUDE>
    <INCLUDE>PlannedEstimatedTimeAtLocationIsValid</INCLUDE>
    <INCLUDE>TrackAtLocation</INCLUDE>
    <INCLUDE>ToLocation</INCLUDE>
    <INCLUDE>FromLocation</INCLUDE>
    <INCLUDE>ViaToLocation</INCLUDE>
    <INCLUDE>LocationSignature</INCLUDE>
    <INCLUDE>Canceled</INCLUDE>
    <INCLUDE>Deleted</INCLUDE>
    <INCLUDE>ProductInformation</INCLUDE>
    <INCLUDE>Operator</INCLUDE>
    <INCLUDE>InformationOwner</INCLUDE>
    <INCLUDE>Deviation</INCLUDE>
  </QUERY>
</REQUEST>"""

    try:
        data = _post(xml)
        announcements = data["RESPONSE"]["RESULT"][0].get("TrainAnnouncement", [])
    except Exception as exc:
        log.warning("TrainAnnouncement fetch failed: %s", exc)
        return {}

    result: dict[str, dict] = {}
    for ann in announcements:
        if ann.get("Deleted"):
            continue
        loc_sig = ann.get("LocationSignature", "")
        activity = ann.get("ActivityType", "")  # "Avgang" or "Ankomst"

        sched_time = _ts_to_unix(ann.get("AdvertisedTimeAtLocation", ""))
        if sched_time is None:
            continue

        est_ts = ann.get("EstimatedTimeAtLocation", "")
        planned_est = ann.get("PlannedEstimatedTimeAtLocation", "")
        planned_valid = ann.get("PlannedEstimatedTimeAtLocationIsValid", False)

        # Use EstimatedTime if present, else PlannedEstimated if valid
        rt_str = est_ts or (planned_est if planned_valid else "")
        rt_time = _ts_to_unix(rt_str) if rt_str else None
        is_realtime = rt_time is not None

        to_locs = ann.get("ToLocation", []) or []
        from_locs = ann.get("FromLocation", []) or []
        via_locs = ann.get("ViaToLocation", []) or []

        dest_sig = to_locs[0]["LocationName"] if to_locs else ""
        origin_sig = from_locs[0]["LocationName"] if from_locs else ""
        # Sort via locations by Order field
        via_sigs = [v["LocationName"] for v in sorted(via_locs, key=lambda v: v.get("Order", 0))]

        product_info = ann.get("ProductInformation", []) or []
        product = product_info[0]["Description"] if product_info else ""

        deviation = ann.get("Deviation", []) or []
        deviation_texts = [d.get("Description", "") for d in deviation if d.get("Description")]

        entry = {
            "train_number": ann.get("AdvertisedTrainIdent", ""),
            "scheduled_time": sched_time,
            "realtime_time": rt_time,
            "is_realtime": is_realtime,
            "track": ann.get("TrackAtLocation", ""),
            "dest_sig": dest_sig,
            "origin_sig": origin_sig,
            "via_sigs": via_sigs,
            "canceled": ann.get("Canceled", False),
            "product": product,
            "operator": ann.get("Operator", "") or ann.get("InformationOwner", ""),
            "deviation": deviation_texts,
        }

        bucket = result.setdefault(loc_sig, {"departures": [], "arrivals": []})
        if activity == "Avgang":
            bucket["departures"].append(entry)
        elif activity == "Ankomst":
            bucket["arrivals"].append(entry)

    return result


def fetch_train_positions(location_signatures: set | None = None) -> list:
    """Fetch active TrainPosition objects.

    Returns list of dicts with:
        train_number, lat, lon, bearing, speed, timestamp
    If location_signatures is given, only return trains whose
    AdvertisedTrainNumber matches trains expected at those stations
    (caller must filter by train_number whitelist).
    """
    if not config.TRAFIKVERKET_API_KEY:
        return []

    xml = f"""<REQUEST>
  <LOGIN authenticationkey="{config.TRAFIKVERKET_API_KEY}" />
  <QUERY objecttype="TrainPosition" schemaversion="1.1" limit="1000">
    <FILTER>
      <EQ name="Status.Active" value="true" />
    </FILTER>
    <INCLUDE>Train.AdvertisedTrainNumber</INCLUDE>
    <INCLUDE>Train.OperationalTrainNumber</INCLUDE>
    <INCLUDE>Position.WGS84</INCLUDE>
    <INCLUDE>Bearing</INCLUDE>
    <INCLUDE>Speed</INCLUDE>
    <INCLUDE>TimeStamp</INCLUDE>
    <INCLUDE>Deleted</INCLUDE>
  </QUERY>
</REQUEST>"""

    try:
        data = _post(xml)
        positions = data["RESPONSE"]["RESULT"][0].get("TrainPosition", [])
    except Exception as exc:
        log.warning("TrainPosition fetch failed: %s", exc)
        return []

    result = []
    for pos in positions:
        if pos.get("Deleted"):
            continue
        train = pos.get("Train", {})
        adv_num = train.get("AdvertisedTrainNumber", "") or train.get("OperationalTrainNumber", "")
        wgs = pos.get("Position", {}).get("WGS84", "")
        m = re.search(r"POINT\s*\(([0-9.]+)\s+([0-9.]+)\)", wgs)
        if not m:
            continue
        lon, lat = float(m.group(1)), float(m.group(2))
        ts = _ts_to_unix(pos.get("TimeStamp", ""))
        result.append({
            "train_number": adv_num,
            "lat": lat,
            "lon": lon,
            "bearing": pos.get("Bearing"),
            "speed": pos.get("Speed"),
            "timestamp": ts,
        })

    return result
