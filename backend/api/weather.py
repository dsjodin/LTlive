from flask import Blueprint, jsonify
import requests
import time
import threading

import config

weather_bp = Blueprint('weather', __name__)

_cache = {'data': None, 'ts': 0}
_lock = threading.Lock()
CACHE_TTL = 600  # 10 minutes

SMHI_URL = (
    "https://opendata-download-metfcst.smhi.se"
    "/api/category/snow1g/version/1/geotype/point"
    f"/lon/{config.MAP_CENTER_LON}/lat/{config.MAP_CENTER_LAT}/data.json"
)


def _fetch_smhi():
    r = requests.get(SMHI_URL, timeout=10)
    r.raise_for_status()
    ts_entry = r.json()['timeSeries'][0]
    data = ts_entry['data']
    return {
        'temp': data.get('air_temperature'),
        'wind': data.get('wind_speed'),
        'symbol': data.get('symbol_code'),
        'precip': data.get('predominant_precipitation_type_at_surface'),
        'valid_time': ts_entry['time'],
    }


@weather_bp.route('/api/weather')
def get_weather():
    with _lock:
        if time.time() - _cache['ts'] > CACHE_TTL or _cache['data'] is None:
            try:
                _cache['data'] = _fetch_smhi()
                _cache['ts'] = time.time()
            except Exception as e:
                if _cache['data'] is None:
                    return jsonify({'error': str(e)}), 503
        return jsonify(_cache['data'])
