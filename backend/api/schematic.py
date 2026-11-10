"""Schematic map Blueprint - model for stadstrafiken.html and schematic-editor.html."""

import json
import os
import threading

from flask import Blueprint, jsonify, request

import config
from api.admin import _require_admin_key
from schematic_builder import build_schematic
from stores.site_config_store import site_config

bp = Blueprint("schematic", __name__)

_gen_lock = threading.Lock()
_generated: dict = {}


def _city_lines():
    return site_config.get()["lines"].get("stadstrafiken") or ["1", "2", "3", "4", "5", "6", "7"]


def _load_saved():
    try:
        with open(config.SCHEMATIC_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _generate(lines):
    """Build (and cache until the GTFS files change) a model for *lines*."""
    st = os.path.join(config.GTFS_DATA_DIR, "stop_times.txt")
    key = (tuple(lines), os.path.getmtime(st) if os.path.exists(st) else None)
    with _gen_lock:
        if key not in _generated:
            _generated.clear()
            _generated[key] = build_schematic(lines)
        return _generated[key]


@bp.route("/api/schematic")
def get_schematic():
    """Saved model, or a generated start layout if nothing has been saved yet."""
    model = _load_saved()
    if model:
        return jsonify({**model, "saved": True})
    model = _generate(_city_lines())
    if not model:
        return jsonify({"error": "GTFS-data saknas"}), 503
    return jsonify({**model, "saved": False})


@bp.route("/api/admin/schematic/generate")
@_require_admin_key
def generate_schematic():
    lines = [s.strip() for s in request.args.get("lines", "").split(",") if s.strip()] or _city_lines()
    model = _generate(lines)
    if not model:
        return jsonify({"error": "GTFS-data saknas"}), 503
    return jsonify(model)


@bp.route("/api/admin/schematic", methods=["PUT"])
@_require_admin_key
def save_schematic():
    data = request.get_json(silent=True)
    if (not isinstance(data, dict) or not isinstance(data.get("nodes"), dict)
            or not isinstance(data.get("edges"), list) or not isinstance(data.get("lines"), dict)):
        return jsonify({"error": "Ogiltig kartmodell"}), 400
    data.pop("saved", None)
    os.makedirs(os.path.dirname(config.SCHEMATIC_FILE) or ".", exist_ok=True)
    tmp = config.SCHEMATIC_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, config.SCHEMATIC_FILE)
    return jsonify({"ok": True})
