"""Transit analytics — punctuality, delay trends, and peak hour analysis.

Collects delay observations from each GTFS-RT poll and persists hourly
aggregates to a SQLite database.  Provides API-friendly query functions
used by the /api/analytics/* endpoints.

Tables:
    delay_observations  – one row per (route, hour) with aggregated stats
    vehicle_counts      – active vehicle counts per (hour, weekday)
"""

import os
import sqlite3
import threading
import time
from datetime import datetime, timezone, timedelta

_DB_PATH = os.environ.get("ANALYTICS_DB_PATH", "/app/data/stats/analytics.db")
_lock = threading.Lock()

# CET/CEST for Swedish local time
_CET = timezone(timedelta(hours=1))


def _conn():
    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    c = sqlite3.connect(_DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db():
    """Create analytics tables if they don't exist."""
    with _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS delay_observations (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                route_id        TEXT NOT NULL,
                route_short_name TEXT NOT NULL,
                hour_bucket     INTEGER NOT NULL,
                weekday         INTEGER NOT NULL,
                total_vehicles  INTEGER NOT NULL DEFAULT 0,
                on_time_count   INTEGER NOT NULL DEFAULT 0,
                late_count      INTEGER NOT NULL DEFAULT 0,
                early_count     INTEGER NOT NULL DEFAULT 0,
                sum_delay_sec   INTEGER NOT NULL DEFAULT 0,
                max_delay_sec   INTEGER NOT NULL DEFAULT 0,
                min_delay_sec   INTEGER NOT NULL DEFAULT 0,
                sample_count    INTEGER NOT NULL DEFAULT 0
            )
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS ix_delay_hour
            ON delay_observations(hour_bucket)
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS ix_delay_route
            ON delay_observations(route_id, hour_bucket)
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS vehicle_counts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                hour_bucket INTEGER NOT NULL,
                weekday     INTEGER NOT NULL,
                bus_count   INTEGER NOT NULL DEFAULT 0,
                train_count INTEGER NOT NULL DEFAULT 0
            )
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS ix_vcount_hour
            ON vehicle_counts(hour_bucket)
        """)
        # Retention: delete data older than 30 days
        cutoff = int(time.time()) - 30 * 86400
        c.execute("DELETE FROM delay_observations WHERE hour_bucket < ?", (cutoff,))
        c.execute("DELETE FROM vehicle_counts WHERE hour_bucket < ?", (cutoff,))


def _hour_bucket(ts: float | None = None) -> tuple[int, int]:
    """Return (hour_bucket_unix, weekday_0_mon) for the given timestamp."""
    dt = datetime.fromtimestamp(ts or time.time(), tz=_CET)
    # Truncate to hour
    dt_hour = dt.replace(minute=0, second=0, microsecond=0)
    return int(dt_hour.timestamp()), dt_hour.weekday()


def record_delay_snapshot(vehicles: list, routes: dict) -> None:
    """Record delay observations from a GTFS-RT poll.

    Called from bus_provider.poll_realtime() after vehicles are enriched.
    Groups vehicles by route and records per-route delay statistics for
    the current hour bucket.

    Args:
        vehicles: List of vehicle dicts with optional delay_seconds field.
        routes: Dict of route_id -> route metadata (from gtfs_store).
    """
    if not vehicles:
        return

    hour_bucket, weekday = _hour_bucket()

    # Group by route
    by_route: dict[str, list] = {}
    bus_count = 0
    train_count = 0
    for v in vehicles:
        route_id = v.get("route_id", "")
        if not route_id:
            continue
        vtype = v.get("vehicle_type", "bus")
        if vtype == "train":
            train_count += 1
        else:
            bus_count += 1
        by_route.setdefault(route_id, []).append(v)

    rows = []
    for route_id, vehs in by_route.items():
        route = routes.get(route_id, {})
        rsn = route.get("route_short_name", "?")

        total = len(vehs)
        on_time = 0
        late = 0
        early = 0
        sum_delay = 0
        max_d = 0
        min_d = 0
        samples = 0

        for v in vehs:
            d = v.get("delay_seconds")
            if d is None:
                continue
            samples += 1
            sum_delay += d
            if d > max_d:
                max_d = d
            if d < min_d:
                min_d = d
            if d <= 60:       # Within 1 minute = on time
                on_time += 1
            elif d > 60:
                late += 1
            else:
                early += 1

        if samples == 0:
            continue

        rows.append((
            route_id, rsn, hour_bucket, weekday,
            total, on_time, late, early,
            sum_delay, max_d, min_d, samples,
        ))

    if not rows:
        return

    with _lock, _conn() as c:
        c.executemany("""
            INSERT INTO delay_observations
            (route_id, route_short_name, hour_bucket, weekday,
             total_vehicles, on_time_count, late_count, early_count,
             sum_delay_sec, max_delay_sec, min_delay_sec, sample_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, rows)
        c.execute("""
            INSERT INTO vehicle_counts (hour_bucket, weekday, bus_count, train_count)
            VALUES (?, ?, ?, ?)
        """, (hour_bucket, weekday, bus_count, train_count))


def get_punctuality(days: int = 7) -> list[dict]:
    """Return punctuality percentage per route for the last N days.

    Returns sorted list of {route_short_name, on_time_pct, avg_delay_min,
    total_samples, late_pct, early_pct}.
    """
    cutoff = int(time.time()) - days * 86400
    with _conn() as c:
        rows = c.execute("""
            SELECT route_short_name,
                   SUM(on_time_count) AS on_time,
                   SUM(late_count)    AS late,
                   SUM(early_count)   AS early,
                   SUM(sample_count)  AS samples,
                   SUM(sum_delay_sec) AS total_delay,
                   MAX(max_delay_sec) AS worst_delay
            FROM delay_observations
            WHERE hour_bucket >= ?
            GROUP BY route_short_name
            HAVING samples > 0
            ORDER BY route_short_name
        """, (cutoff,)).fetchall()

    result = []
    for r in rows:
        samples = r["samples"]
        result.append({
            "route_short_name": r["route_short_name"],
            "on_time_pct":      round(100 * r["on_time"] / samples, 1),
            "late_pct":         round(100 * r["late"] / samples, 1),
            "early_pct":        round(100 * r["early"] / samples, 1),
            "avg_delay_min":    round(r["total_delay"] / samples / 60, 1),
            "worst_delay_min":  round(r["worst_delay"] / 60, 1),
            "total_samples":    samples,
        })
    return sorted(result, key=lambda x: x["on_time_pct"])


def get_delay_trends(days: int = 7) -> dict[str, list[dict]]:
    """Return hourly average delay per route for the last N days.

    Returns {route_short_name: [{hour_iso, avg_delay_min, on_time_pct, samples}, ...]}.
    Used for rendering line charts on the frontend.
    """
    cutoff = int(time.time()) - days * 86400
    with _conn() as c:
        rows = c.execute("""
            SELECT route_short_name, hour_bucket,
                   SUM(sum_delay_sec) AS total_delay,
                   SUM(sample_count)  AS samples,
                   SUM(on_time_count) AS on_time
            FROM delay_observations
            WHERE hour_bucket >= ?
            GROUP BY route_short_name, hour_bucket
            ORDER BY route_short_name, hour_bucket
        """, (cutoff,)).fetchall()

    result: dict[str, list] = {}
    for r in rows:
        rsn = r["route_short_name"]
        samples = r["samples"]
        if samples == 0:
            continue
        dt = datetime.fromtimestamp(r["hour_bucket"], tz=_CET)
        result.setdefault(rsn, []).append({
            "hour_iso":     dt.isoformat(),
            "avg_delay_min": round(r["total_delay"] / samples / 60, 1),
            "on_time_pct":  round(100 * r["on_time"] / samples, 1),
            "samples":      samples,
        })
    return result


def get_peak_hours(days: int = 7) -> list[dict]:
    """Return vehicle counts per (hour_of_day, weekday) for heatmap.

    Returns [{hour, weekday, avg_buses, avg_trains, avg_total}, ...].
    """
    cutoff = int(time.time()) - days * 86400
    with _conn() as c:
        rows = c.execute("""
            SELECT weekday,
                   CAST(strftime('%H', hour_bucket, 'unixepoch', 'localtime') AS INTEGER) AS hour_of_day,
                   AVG(bus_count)              AS avg_buses,
                   AVG(train_count)            AS avg_trains,
                   AVG(bus_count + train_count) AS avg_total,
                   COUNT(*)                    AS data_points
            FROM vehicle_counts
            WHERE hour_bucket >= ?
            GROUP BY weekday, hour_of_day
            ORDER BY weekday, hour_of_day
        """, (cutoff,)).fetchall()

    return [dict(r) for r in rows]


def cleanup_old_data(max_days: int = 30) -> int:
    """Delete analytics data older than max_days. Returns rows deleted."""
    cutoff = int(time.time()) - max_days * 86400
    with _lock, _conn() as c:
        c1 = c.execute("DELETE FROM delay_observations WHERE hour_bucket < ?", (cutoff,)).rowcount
        c2 = c.execute("DELETE FROM vehicle_counts WHERE hour_bucket < ?", (cutoff,)).rowcount
    return c1 + c2
