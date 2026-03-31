"""Flask application factory for LTlive."""

import os

from dotenv import load_dotenv
load_dotenv()

from flask import Flask
from flask_cors import CORS

import config
import analytics as _analytics
import stats as _stats
from stores.site_config_store import site_config
from tasks.scheduler import start_background_tasks

# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------

app = Flask(__name__)

_allowed_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
CORS(app, resources={r"/api/*": {"origins": _allowed_origins or [], "methods": ["GET", "POST"]}})

# ---------------------------------------------------------------------------
# Register blueprints
# ---------------------------------------------------------------------------

from api.debug import bp as _debug_bp
from api.departures import bp as _departures_bp
from api.routes_shapes import bp as _routes_shapes_bp
from api.status import bp as _status_bp
from api.stops import bp as _stops_bp
from api.vehicles import bp as _vehicles_bp
from api.weather import weather_bp as _weather_bp
from api.traffic import bp as _traffic_bp
from api.analytics_api import bp as _analytics_bp
from api.admin import bp as _admin_bp

app.register_blueprint(_debug_bp)
app.register_blueprint(_departures_bp)
app.register_blueprint(_routes_shapes_bp)
app.register_blueprint(_status_bp)
app.register_blueprint(_stops_bp)
app.register_blueprint(_vehicles_bp)
app.register_blueprint(_weather_bp)
app.register_blueprint(_traffic_bp)
app.register_blueprint(_analytics_bp)
app.register_blueprint(_admin_bp)

# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

site_config.init(config.SITE_CONFIG_FILE)
_stats.init_db()
_analytics.init_db()
start_background_tasks()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
