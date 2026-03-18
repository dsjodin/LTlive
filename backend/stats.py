"""Visitor statistics – SQLite-backed, privacy-friendly (no plain IPs stored)."""

import hashlib
import os
import sqlite3
import threading
import time

_DB_PATH = os.environ.get("STATS_DB_PATH", "/app/data/stats/stats.db")
_lock = threading.Lock()


def _conn():
    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    c = sqlite3.connect(_DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    with _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS visits (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id  TEXT NOT NULL,
                page        TEXT NOT NULL DEFAULT '/',
                ip_day_hash TEXT,
                started_at  INTEGER NOT NULL,
                duration    INTEGER
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS ix_started ON visits(started_at)")
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_session ON visits(session_id)")


def _ip_hash(ip: str) -> str:
    """Hash IP with daily salt so the same visitor counts once per day."""
    day = time.strftime("%Y-%m-%d")
    return hashlib.sha256(f"{day}:{ip}".encode()).hexdigest()[:16]


def record_visit(session_id: str, page: str, ip: str):
    with _lock, _conn() as c:
        c.execute(
            "INSERT OR IGNORE INTO visits (session_id, page, ip_day_hash, started_at) "
            "VALUES (?, ?, ?, ?)",
            (session_id, page or "/", _ip_hash(ip), int(time.time())),
        )


def record_leave(session_id: str, duration: int):
    with _lock, _conn() as c:
        c.execute(
            "UPDATE visits SET duration = ? WHERE session_id = ? AND duration IS NULL",
            (max(0, int(duration)), session_id),
        )


def get_stats():
    now = int(time.time())
    day_start   = now - (now % 86400)          # midnight UTC
    week_start  = now - 7  * 86400
    month_start = now - 30 * 86400

    with _conn() as c:
        def _count(since):
            return c.execute(
                "SELECT COUNT(*) FROM visits WHERE started_at >= ?", (since,)
            ).fetchone()[0]

        def _unique(since):
            return c.execute(
                "SELECT COUNT(DISTINCT ip_day_hash) FROM visits WHERE started_at >= ?",
                (since,)
            ).fetchone()[0]

        def _avg_dur(since):
            row = c.execute(
                "SELECT AVG(duration) FROM visits "
                "WHERE started_at >= ? AND duration IS NOT NULL AND duration > 0",
                (since,)
            ).fetchone()[0]
            return round(row) if row else None

        pages = [
            dict(r) for r in c.execute(
                "SELECT page, COUNT(*) AS visits "
                "FROM visits WHERE started_at >= ? "
                "GROUP BY page ORDER BY visits DESC LIMIT 10",
                (month_start,)
            ).fetchall()
        ]

        recent = [
            dict(r) for r in c.execute(
                "SELECT page, started_at, duration "
                "FROM visits ORDER BY started_at DESC LIMIT 20"
            ).fetchall()
        ]

    return {
        "today":        {"visits": _count(day_start),   "unique": _unique(day_start),   "avg_duration": _avg_dur(day_start)},
        "week":         {"visits": _count(week_start),  "unique": _unique(week_start),  "avg_duration": _avg_dur(week_start)},
        "month":        {"visits": _count(month_start), "unique": _unique(month_start), "avg_duration": _avg_dur(month_start)},
        "all_time":     {"visits": _count(0),           "unique": _unique(0),           "avg_duration": _avg_dur(0)},
        "top_pages":    pages,
        "recent":       recent,
    }
