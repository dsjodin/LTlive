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
    if not resp.ok:
        log.warning("Trafikverket API error %s: %s", resp.status_code, resp.text[:500])
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
  <QUERY objecttype="TrainStation" schemaversion="1.0" namespace="rail.infrastructure" limit="10000">
    <FILTER>
      <EQ name="Advertised" value="true" />
    </FILTER>
    <INCLUDE>LocationSignature</INCLUDE>
    <INCLUDE>AdvertisedLocationName</INCLUDE>
    <INCLUDE>AdvertisedShortLocationName</INCLUDE>
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
            short_name = st.get("AdvertisedShortLocationName", "") or name
            result[sig] = {"name": name, "short_name": short_name, "lat": lat, "lon": lon}
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
    <INCLUDE>TimeAtLocation</INCLUDE>
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
    <INCLUDE>OtherInformation</INCLUDE>
    <INCLUDE>TypeOfTraffic</INCLUDE>
    <INCLUDE>EstimatedTimeIsPreliminary</INCLUDE>
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

        actual_ts = ann.get("TimeAtLocation", "")       # set after train has passed
        est_ts = ann.get("EstimatedTimeAtLocation", "")  # running estimate
        planned_est = ann.get("PlannedEstimatedTimeAtLocation", "")
        planned_valid = ann.get("PlannedEstimatedTimeAtLocationIsValid", False)

        # Priority: actual passage time > running estimate > planned estimate
        rt_str = actual_ts or est_ts or (planned_est if planned_valid else "")
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

        other_info_list = ann.get("OtherInformation", []) or []
        other_info_texts = [o.get("Description", "") for o in other_info_list if o.get("Description")]

        traffic_type_list = ann.get("TypeOfTraffic", []) or []
        traffic_type = traffic_type_list[0].get("Description", "") if traffic_type_list else ""

        # Mark as preliminary only when there's an estimated time (not actual) and the flag is set
        est_is_prelim = ann.get("EstimatedTimeIsPreliminary", False)
        preliminary = bool(est_is_prelim and rt_time and not actual_ts)

        entry = {
            "train_number": ann.get("AdvertisedTrainIdent", ""),
            "scheduled_time": sched_time,
            "realtime_time": rt_time,
            "is_realtime": is_realtime,
            "preliminary": preliminary,
            "track": ann.get("TrackAtLocation", ""),
            "dest_sig": dest_sig,
            "origin_sig": origin_sig,
            "via_sigs": via_sigs,
            "canceled": ann.get("Canceled", False),
            "product": product,
            "operator": ann.get("Operator", "") or ann.get("InformationOwner", ""),
            "deviation": deviation_texts,
            "other_info": other_info_texts,
            "traffic_type": traffic_type,
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
        train_number, operator, lat, lon, bearing, speed, timestamp
    InformationOwner is included so callers can colour trains that are not
    matched via TrainAnnouncement data (e.g. radius-filtered trains).

    Fetches all active trains in Sweden (limit=2000).  The geo-filtering to
    TV_POSITION_RADIUS_KM is done locally in app.py after the fetch.
    Sweden typically has ~300–500 active trains so 2000 gives ample headroom.
    """
    if not config.TRAFIKVERKET_API_KEY:
        return []

    xml = f"""<REQUEST>
  <LOGIN authenticationkey="{config.TRAFIKVERKET_API_KEY}" />
  <QUERY objecttype="TrainPosition" namespace="järnväg.trafikinfo" schemaversion="1.1" limit="2000">
    <FILTER>
      <GT name="TimeStamp" value="$dateadd(-0:10:00)" />
    </FILTER>
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
        # AdvertisedTrainNumber is the public-facing number (e.g. "10" for SJ)
        # OperationalTrainNumber is the internal number — prefer Advertised
        adv_num = train.get("AdvertisedTrainNumber", "") or train.get("OperationalTrainNumber", "")
        wgs = pos.get("Position", {}).get("WGS84", "")
        m = re.search(r"POINT\s*\(([0-9.]+)\s+([0-9.]+)\)", wgs)
        if not m:
            continue
        lon, lat = float(m.group(1)), float(m.group(2))
        ts = _ts_to_unix(pos.get("TimeStamp", ""))
        speed_kmh = pos.get("Speed")
        result.append({
            "train_number": adv_num,
            "operator": "",  # InformationOwner not available in TrainPosition; resolved via announcements in app.py
            "lat": lat,
            "lon": lon,
            "bearing": pos.get("Bearing"),
            "speed": speed_kmh / 3.6 if speed_kmh is not None else None,  # API returns km/h, convert to m/s
            "timestamp": ts,
        })

    return result


_MSG_STATUS_ORDER = {"StortLage": 0, "Hog": 1, "Normal": 2, "Lag": 3}


def fetch_station_messages(location_signatures: list[str]) -> dict:
    """Fetch TrainStationMessage for given LocationSignatures.

    Returns {location_sig: [{"body": str, "media_type": str, "status": str,
                              "start": int|None, "end": int|None}]}.
    Only returns non-deleted messages whose EndDateTime is in the future,
    sorted by importance (StortLage → Hog → Normal → Lag).
    """
    if not config.TRAFIKVERKET_API_KEY or not location_signatures:
        return {}

    # TrainStationMessage uses LocationCode (= LocationSignature value)
    if len(location_signatures) == 1:
        loc_filter = f'<EQ name="LocationCode" value="{location_signatures[0]}" />'
    else:
        parts = "".join(
            f'<EQ name="LocationCode" value="{s}" />'
            for s in location_signatures
        )
        loc_filter = f"<OR>{parts}</OR>"

    xml = f"""<REQUEST>
  <LOGIN authenticationkey="{config.TRAFIKVERKET_API_KEY}" />
  <QUERY objecttype="TrainStationMessage" schemaversion="1.0" limit="100">
    <FILTER>
      <AND>
        {loc_filter}
        <GT name="EndDateTime" value="$dateadd(-0:01:00)" />
        <EQ name="Deleted" value="false" />
      </AND>
    </FILTER>
    <INCLUDE>LocationCode</INCLUDE>
    <INCLUDE>FreeText</INCLUDE>
    <INCLUDE>MediaType</INCLUDE>
    <INCLUDE>Status</INCLUDE>
    <INCLUDE>StartDateTime</INCLUDE>
    <INCLUDE>EndDateTime</INCLUDE>
    <INCLUDE>PlatformSignAttributes</INCLUDE>
  </QUERY>
</REQUEST>"""

    try:
        data = _post(xml)
        messages = data["RESPONSE"]["RESULT"][0].get("TrainStationMessage", [])
    except Exception as exc:
        log.warning("TrainStationMessage fetch failed: %s", exc)
        return {}

    result: dict[str, list] = {}
    for msg in messages:
        loc_sig = msg.get("LocationCode", "")
        if not loc_sig:
            continue
        # Extract tracks for Plattformsskylt messages
        tracks: list[str] = []
        ps_attrs = msg.get("PlatformSignAttributes") or {}
        track_list = ps_attrs.get("TrackList") or {}
        raw_tracks = track_list.get("Track") or []
        # API may return a single string or a list
        if isinstance(raw_tracks, str):
            tracks = [raw_tracks]
        else:
            tracks = list(raw_tracks)
        result.setdefault(loc_sig, []).append({
            "body": msg.get("FreeText", ""),
            "media_type": msg.get("MediaType", ""),
            "status": msg.get("Status", "Normal"),
            "tracks": tracks,
            "start": _ts_to_unix(msg.get("StartDateTime", "")),
            "end": _ts_to_unix(msg.get("EndDateTime", "")),
        })

    # Sort each station's messages by importance (highest first)
    for msgs in result.values():
        msgs.sort(key=lambda m: _MSG_STATUS_ORDER.get(m["status"], 2))

    return result
