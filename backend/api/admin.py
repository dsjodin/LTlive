"""Admin Blueprint — site configuration CRUD + maintenance actions."""

import functools

from flask import Blueprint, jsonify, request

import config
from stores.site_config_store import site_config
from tasks.sse_tasks import push_sse

bp = Blueprint("admin", __name__)


def _require_admin_key(fn):
    """Decorator: reject requests without a valid admin API key."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        key = config.ADMIN_API_KEY
        if not key:
            return jsonify({"error": "Admin API is disabled (ADMIN_API_KEY not set)"}), 403
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {key}":
            return jsonify({"error": "Unauthorized"}), 401
        return fn(*args, **kwargs)
    return wrapper


# ---------------------------------------------------------------------------
# Config CRUD
# ---------------------------------------------------------------------------

@bp.route("/api/admin/config", methods=["GET"])
@_require_admin_key
def get_config():
    """Return the full site configuration."""
    return jsonify(site_config.get())


@bp.route("/api/admin/config", methods=["PUT"])
@_require_admin_key
def put_config():
    """Replace the entire site configuration."""
    data = request.get_json(silent=True)
    if not data or not isinstance(data, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400
    site_config.save(data)
    push_sse("config", site_config.frontend())
    return jsonify({"ok": True, "config": site_config.get()})


@bp.route("/api/admin/config", methods=["PATCH"])
@_require_admin_key
def patch_config():
    """Merge partial updates into the site configuration."""
    data = request.get_json(silent=True)
    if not data or not isinstance(data, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400
    updated = site_config.patch(data)
    push_sse("config", site_config.frontend())
    return jsonify({"ok": True, "config": updated})


# ---------------------------------------------------------------------------
# Maintenance actions
# ---------------------------------------------------------------------------

@bp.route("/api/admin/restart-gtfs", methods=["POST"])
@_require_admin_key
def restart_gtfs():
    """Trigger a GTFS data reload (useful after changing operator)."""
    try:
        from providers.bus_provider import refresh_gtfs_static
        refresh_gtfs_static()
        return jsonify({"ok": True, "message": "GTFS reload triggered"})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
