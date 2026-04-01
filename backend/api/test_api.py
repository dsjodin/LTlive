"""Test/health-check Blueprint -- /api/test/* endpoints.

Runs structured checks across all subsystems and returns
pass/warn/fail results grouped by category.
"""

import time

import requests
from flask import Blueprint, jsonify, request as flask_request

import config
from stores.gtfs_store import gtfs_store
from stores.vehicle_store import vehicle_store
from stores.train_store import train_store
from stores.traffic_store import traffic_store

bp = Blueprint("test", __name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check(id, namn, status, meddelande, detaljer=None):
    result = {"id": id, "namn": namn, "status": status, "meddelande": meddelande}
    if detaljer is not None:
        result["detaljer"] = detaljer
    return result


def _is_night():
    """Return True between 00:00 and 05:00 local time."""
    return time.localtime().tm_hour < 5


def _sanitize(msg):
    """Strip API keys from error messages to avoid exposing secrets."""
    s = str(msg)
    for key in (
        config.TRAFIKLAB_GTFS_RT_KEY,
        config.TRAFIKLAB_GTFS_STATIC_KEY,
        config.TRAFIKVERKET_API_KEY,
        config.OXYFI_API_KEY,
        config.ADMIN_API_KEY,
    ):
        if key:
            s = s.replace(key, "***")
    return s


# ---------------------------------------------------------------------------
# Category: Konfiguration
# ---------------------------------------------------------------------------

def _run_config_checks():
    checks = []

    checks.append(_check(
        "config_static_key", "GTFS statisk nyckel",
        "ok" if config.TRAFIKLAB_GTFS_STATIC_KEY else "fail",
        "Nyckel konfigurerad" if config.TRAFIKLAB_GTFS_STATIC_KEY else "TRAFIKLAB_GTFS_STATIC_KEY saknas",
    ))

    checks.append(_check(
        "config_rt_key", "GTFS RT-nyckel",
        "ok" if config.TRAFIKLAB_GTFS_RT_KEY else "fail",
        "Nyckel konfigurerad" if config.TRAFIKLAB_GTFS_RT_KEY else "TRAFIKLAB_GTFS_RT_KEY saknas",
    ))

    checks.append(_check(
        "config_tv_key", "Trafikverket-nyckel",
        "ok" if config.TRAFIKVERKET_API_KEY else "warn",
        "Nyckel konfigurerad" if config.TRAFIKVERKET_API_KEY else "Tagdata inaktiverad (valfri)",
    ))

    checks.append(_check(
        "config_oxyfi_key", "Oxyfi-nyckel",
        "ok" if config.OXYFI_API_KEY else "warn",
        "Nyckel konfigurerad" if config.OXYFI_API_KEY else "Tagpositioner via Oxyfi inaktiverade (valfri)",
    ))

    checks.append(_check(
        "config_operator", "Operator",
        "ok" if config.OPERATOR else "fail",
        config.OPERATOR if config.OPERATOR else "OPERATOR ej satt",
    ))

    return {"namn": "Konfiguration", "kontroller": checks}


# ---------------------------------------------------------------------------
# Category: GTFS-data
# ---------------------------------------------------------------------------

def _run_gtfs_checks():
    checks = []

    with gtfs_store.lock:
        loaded = gtfs_store.loaded
        error = gtfs_store.error
        routes_count = len(gtfs_store.routes)
        stops_count = len(gtfs_store.stops)
        trips_count = len(gtfs_store.trips)

    if loaded:
        checks.append(_check("gtfs_loaded", "GTFS laddad", "ok", "Statisk data laddad"))
    else:
        msg = "GTFS ej laddad"
        if error:
            msg += ": " + _sanitize(error)[:200]
        checks.append(_check("gtfs_loaded", "GTFS laddad", "fail", msg))

    checks.append(_check(
        "gtfs_routes", "Rutter",
        "ok" if routes_count > 0 else "fail",
        f"{routes_count} rutter",
    ))

    checks.append(_check(
        "gtfs_stops", "Hallplatser",
        "ok" if stops_count > 0 else "fail",
        f"{stops_count} hallplatser",
    ))

    checks.append(_check(
        "gtfs_trips", "Turer",
        "ok" if trips_count > 0 else "fail",
        f"{trips_count} turer",
    ))

    return {"namn": "GTFS-data", "kontroller": checks}


# ---------------------------------------------------------------------------
# Category: Realtidsdata
# ---------------------------------------------------------------------------

def _run_realtime_checks():
    checks = []
    now = time.time()

    with vehicle_store.lock:
        last_poll = vehicle_store.last_rt_poll
        last_update = vehicle_store.last_vehicle_update
        last_error = vehicle_store.last_rt_error
        vehicle_count = len(vehicle_store.vehicles)

    # RT poll freshness
    poll_age = now - last_poll if last_poll else None
    max_age = config.RT_POLL_SECONDS * 2
    if poll_age is not None and poll_age < max_age:
        checks.append(_check(
            "rt_poll_recent", "RT-pollning",
            "ok", f"Senaste poll {int(poll_age)}s sedan",
        ))
    elif poll_age is not None:
        checks.append(_check(
            "rt_poll_recent", "RT-pollning",
            "warn", f"Senaste poll {int(poll_age)}s sedan (forvantad inom {max_age}s)",
        ))
    else:
        checks.append(_check(
            "rt_poll_recent", "RT-pollning",
            "fail", "Ingen RT-poll har skett",
        ))

    # Vehicles present
    if vehicle_count > 0:
        checks.append(_check(
            "rt_vehicles", "Fordon",
            "ok", f"{vehicle_count} aktiva fordon",
        ))
    elif _is_night():
        checks.append(_check(
            "rt_vehicles", "Fordon",
            "warn", "Inga fordon (natt -- normalt)",
        ))
    else:
        checks.append(_check(
            "rt_vehicles", "Fordon",
            "fail", "Inga fordon i realtidsdata",
        ))

    # RT error
    if last_error:
        checks.append(_check(
            "rt_no_error", "RT-fel",
            "fail", _sanitize(last_error)[:200],
        ))
    else:
        checks.append(_check(
            "rt_no_error", "RT-fel",
            "ok", "Inga fel",
        ))

    # Data freshness
    update_age = now - last_update if last_update else None
    if update_age is not None and update_age < 60:
        checks.append(_check(
            "rt_freshness", "Dataaktualitet",
            "ok", f"Uppdaterad {int(update_age)}s sedan",
        ))
    elif update_age is not None:
        checks.append(_check(
            "rt_freshness", "Dataaktualitet",
            "warn", f"Uppdaterad {int(update_age)}s sedan",
        ))
    else:
        checks.append(_check(
            "rt_freshness", "Dataaktualitet",
            "fail", "Ingen data har mottagits",
        ))

    return {"namn": "Realtidsdata", "kontroller": checks}


# ---------------------------------------------------------------------------
# Category: API-endpoints
# ---------------------------------------------------------------------------

def _run_api_checks(base_url):
    checks = []

    endpoints = [
        ("api_health", "/api/health", "Health", lambda d: d.get("status") == "ok"),
        ("api_status", "/api/status", "Status", lambda d: "gtfs_loaded" in d),
        ("api_vehicles", "/api/vehicles", "Fordon", lambda d: isinstance(d.get("vehicles"), list)),
        ("api_stops", "/api/stops", "Hallplatser", lambda d: "stops" in d),
        ("api_alerts", "/api/alerts", "Larm", lambda d: "alerts" in d),
        ("api_weather", "/api/weather", "Vader", None),
        ("api_stats", "/api/stats", "Statistik", lambda d: isinstance(d, dict)),
    ]

    for ep_id, path, namn, validate in endpoints:
        url = base_url.rstrip("/") + path
        try:
            r = requests.get(url, timeout=3)
            if r.status_code != 200:
                # Weather is external, downgrade to warn
                status = "warn" if ep_id == "api_weather" else "fail"
                checks.append(_check(ep_id, namn, status, f"HTTP {r.status_code}"))
                continue
            data = r.json()
            if validate and not validate(data):
                checks.append(_check(ep_id, namn, "warn", "Svar saknar forvantade falt"))
            else:
                checks.append(_check(ep_id, namn, "ok", f"HTTP 200"))
        except requests.Timeout:
            checks.append(_check(ep_id, namn, "fail", "Timeout (3s)"))
        except Exception as e:
            checks.append(_check(ep_id, namn, "fail", _sanitize(e)[:200]))

    # SSE stream test
    try:
        r = requests.get(base_url.rstrip("/") + "/api/stream", stream=True, timeout=5)
        got_event = False
        for line in r.iter_lines(decode_unicode=True):
            if line and line.startswith("event:"):
                got_event = True
                break
        r.close()
        if got_event:
            checks.append(_check("api_stream_sse", "SSE-strom", "ok", "Event mottaget"))
        else:
            checks.append(_check("api_stream_sse", "SSE-strom", "warn", "Ingen event inom 5s"))
    except requests.Timeout:
        checks.append(_check("api_stream_sse", "SSE-strom", "warn", "Timeout -- ingen event inom 5s"))
    except Exception as e:
        checks.append(_check("api_stream_sse", "SSE-strom", "fail", _sanitize(e)[:200]))

    return {"namn": "API-endpoints", "kontroller": checks}


# ---------------------------------------------------------------------------
# Category: Tag (Trafikverket)
# ---------------------------------------------------------------------------

def _run_train_checks():
    checks = []

    if not config.TRAFIKVERKET_API_KEY:
        checks.append(_check(
            "tv_skipped", "Trafikverket",
            "warn", "API-nyckel saknas -- tagkontroller hoppas over",
        ))
        return {"namn": "Tag (Trafikverket)", "kontroller": checks}

    # Station mapping
    station_count = len(config.TRAFIKVERKET_STATIONS)
    if station_count > 0:
        checks.append(_check(
            "tv_stations_mapped", "Stationsmappning",
            "ok", f"{station_count} stationer mappade",
        ))
    else:
        checks.append(_check(
            "tv_stations_mapped", "Stationsmappning",
            "warn", "Inga TRAFIKVERKET_STATIONS konfigurerade",
        ))

    with train_store.lock:
        ann_count = len(train_store.announcements)
        last_error = train_store.last_error
        sse_state = train_store.sse_state

    # Announcements
    if ann_count > 0 and not last_error:
        checks.append(_check(
            "tv_announcements", "Annonseringar",
            "ok", f"{ann_count} stationer med data",
        ))
    elif ann_count > 0 and last_error:
        checks.append(_check(
            "tv_announcements", "Annonseringar",
            "warn", f"{ann_count} stationer, men senaste fel: {_sanitize(last_error)[:100]}",
        ))
    else:
        msg = "Inga annonseringar laddade"
        if last_error:
            msg += ": " + _sanitize(last_error)[:100]
        checks.append(_check("tv_announcements", "Annonseringar", "fail", msg))

    # SSE position stream
    if sse_state == "connected":
        checks.append(_check("tv_positions_sse", "Positionsstrom (SSE)", "ok", "Ansluten"))
    elif sse_state == "reconnecting":
        checks.append(_check("tv_positions_sse", "Positionsstrom (SSE)", "warn", "Ateransluter"))
    else:
        checks.append(_check("tv_positions_sse", "Positionsstrom (SSE)", "fail", "Frakopplad"))

    return {"namn": "Tag (Trafikverket)", "kontroller": checks}


# ---------------------------------------------------------------------------
# Category: Trafik
# ---------------------------------------------------------------------------

def _run_traffic_checks():
    checks = []

    if not config.TRAFFIC_ENABLED:
        checks.append(_check(
            "traffic_disabled", "Trafikinferens",
            "warn", "TRAFFIC_ENABLED=false -- inaktiverad",
        ))
        return {"namn": "Trafik", "kontroller": checks}

    with traffic_store.lock:
        built = traffic_store.built
        seg_count = traffic_store.segment_count
        states_count = len(traffic_store.segment_states)

    if built and seg_count > 0:
        checks.append(_check(
            "traffic_segments", "Trafiksegment",
            "ok", f"{seg_count} segment byggda",
        ))
    else:
        checks.append(_check(
            "traffic_segments", "Trafiksegment",
            "fail", "Inga segment byggda",
        ))

    if states_count > 0:
        checks.append(_check(
            "traffic_states", "Segmenttillstand",
            "ok", f"{states_count} segment med tillstand",
        ))
    else:
        checks.append(_check(
            "traffic_states", "Segmenttillstand",
            "warn", "Inga segmenttillstand an (vantar pa data)",
        ))

    return {"namn": "Trafik", "kontroller": checks}


# ---------------------------------------------------------------------------
# Category: SMHI (vader)
# ---------------------------------------------------------------------------

def _run_smhi_checks():
    checks = []

    smhi_url = (
        "https://opendata-download-metfcst.smhi.se"
        "/api/category/pmp3g/version/2/geotype/point"
        f"/lon/{config.MAP_CENTER_LON}/lat/{config.MAP_CENTER_LAT}/data.json"
    )

    try:
        r = requests.get(smhi_url, timeout=5)
        if r.status_code != 200:
            checks.append(_check(
                "smhi_api", "SMHI API-anrop",
                "warn", f"HTTP {r.status_code}",
            ))
            return {"namn": "SMHI (vader)", "kontroller": checks}

        data = r.json()
        ts_list = data.get("timeSeries", [])
        if not ts_list:
            checks.append(_check(
                "smhi_api", "SMHI API-anrop",
                "warn", "Svar saknar timeSeries",
            ))
            return {"namn": "SMHI (vader)", "kontroller": checks}

        checks.append(_check(
            "smhi_api", "SMHI API-anrop",
            "ok", f"HTTP 200, {len(ts_list)} tidpunkter",
        ))

        # Parse first entry
        entry = ts_list[0]
        params = {p["name"]: p["values"][0] for p in entry.get("parameters", [])}
        temp = params.get("t")
        wind = params.get("ws")
        valid = entry.get("validTime", "--")

        if temp is not None:
            checks.append(_check(
                "smhi_temp", "Temperatur",
                "ok", f"{temp} C (giltig: {valid})",
            ))
        else:
            checks.append(_check(
                "smhi_temp", "Temperatur",
                "warn", "Temperatur saknas i svar",
            ))

        if wind is not None:
            checks.append(_check(
                "smhi_wind", "Vind",
                "ok", f"{wind} m/s",
            ))

    except requests.Timeout:
        checks.append(_check("smhi_api", "SMHI API-anrop", "warn", "Timeout (5s)"))
    except Exception as e:
        checks.append(_check("smhi_api", "SMHI API-anrop", "warn", _sanitize(e)[:200]))

    return {"namn": "SMHI (vader)", "kontroller": checks}


# ---------------------------------------------------------------------------
# Run all
# ---------------------------------------------------------------------------

def _run_all(base_url=None):
    kategorier = [
        _run_config_checks(),
        _run_gtfs_checks(),
        _run_realtime_checks(),
    ]

    if base_url:
        kategorier.append(_run_api_checks(base_url))

    kategorier.append(_run_train_checks())
    kategorier.append(_run_traffic_checks())
    kategorier.append(_run_smhi_checks())

    counts = {"ok": 0, "warn": 0, "fail": 0}
    for kat in kategorier:
        for k in kat["kontroller"]:
            counts[k["status"]] = counts.get(k["status"], 0) + 1

    return {
        "tidpunkt": int(time.time()),
        "sammanfattning": {
            **counts,
            "totalt": counts["ok"] + counts["warn"] + counts["fail"],
        },
        "kategorier": kategorier,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@bp.route("/api/test/run")
def run_tests():
    base_url = flask_request.host_url
    return jsonify(_run_all(base_url))
