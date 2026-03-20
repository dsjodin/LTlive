"""APScheduler setup and application startup.

Call start_background_tasks() once from app.py after the Flask app is created.
"""

import threading

import config
import oxyfi
from apscheduler.schedulers.background import BackgroundScheduler

from providers.bus_provider import (
    init_gtfs_static,
    poll_realtime,
    refresh_gtfs_static,
    refresh_static_departures,
    retry_gtfs_if_needed,
)
from providers.train_provider import init_trafikverket, poll_trafikverket
from tasks.sse_tasks import push_sse, push_vehicle_update


def _poll_realtime_with_alerts():
    """Wrapper so poll_realtime can push alert SSE events without importing sse_tasks directly."""
    def _push_alerts(alerts):
        push_sse("alerts", {"alerts": alerts, "count": len(alerts)})

    poll_realtime(push_alerts_callback=_push_alerts)


def start_background_tasks() -> None:
    """Initialize GTFS data and start all background polling."""

    # Load GTFS static in a background thread so the web server starts immediately.
    threading.Thread(target=init_gtfs_static, daemon=True, name="gtfs-init").start()

    scheduler = BackgroundScheduler()
    scheduler.add_job(_poll_realtime_with_alerts, "interval",
                      seconds=config.RT_POLL_SECONDS, max_instances=1)
    scheduler.add_job(refresh_gtfs_static, "interval",
                      hours=config.GTFS_REFRESH_HOURS, max_instances=1)
    scheduler.add_job(refresh_static_departures, "cron",
                      hour=0, minute=1, max_instances=1)
    scheduler.add_job(retry_gtfs_if_needed, "interval",
                      seconds=60, max_instances=1)
    scheduler.add_job(push_vehicle_update, "interval",
                      seconds=config.RT_POLL_SECONDS, max_instances=1)

    if config.TRAFIKVERKET_API_KEY:
        scheduler.add_job(poll_trafikverket, "interval",
                          seconds=config.TRAFIKVERKET_POLL_SECONDS, max_instances=1)

    if config.TRAFFIC_ENABLED:
        from traffic_inference import save_baseline
        scheduler.add_job(save_baseline, "interval",
                          minutes=30, max_instances=1, id="save_traffic_baseline")

    scheduler.start()

    # Kick off first RT poll and Oxyfi WebSocket immediately
    threading.Thread(target=_poll_realtime_with_alerts, daemon=True, name="rt-init").start()
    oxyfi.start()

    if config.TRAFIKVERKET_API_KEY:
        threading.Thread(target=init_trafikverket, daemon=True, name="tv-init").start()
