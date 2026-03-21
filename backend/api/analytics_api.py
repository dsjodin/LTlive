"""Analytics Blueprint — /api/analytics/*.

Exposes punctuality statistics, delay trends, and peak hour data
collected by the analytics module.
"""

from flask import Blueprint, jsonify, request

import analytics

bp = Blueprint("analytics", __name__)


@bp.route("/api/analytics/punctuality")
def punctuality():
    """Punctuality percentage per route (last N days)."""
    days = max(1, min(int(request.args.get("days", 7)), 30))
    return jsonify(analytics.get_punctuality(days))


@bp.route("/api/analytics/trends")
def delay_trends():
    """Hourly delay trend per route (last N days)."""
    days = max(1, min(int(request.args.get("days", 7)), 30))
    return jsonify(analytics.get_delay_trends(days))


@bp.route("/api/analytics/peak-hours")
def peak_hours():
    """Vehicle counts per (hour, weekday) for heatmap (last N days)."""
    days = max(1, min(int(request.args.get("days", 7)), 30))
    return jsonify(analytics.get_peak_hours(days))
