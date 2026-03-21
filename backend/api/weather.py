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
    "/api/category/pmp3g/version/2/geotype/point"
    f"/lon/{config.MAP_CENTER_LON}/lat/{config.MAP_CENTER_LAT}/data.json"
)


def _fetch_smhi():
    r = requests.get(SMHI_URL, timeout=10)
    r.raise_for_status()
    ts_entry = r.json()['timeSeries'][0]
    params = {p['name']: p['values'][0] for p in ts_entry['parameters']}
    return {
        'temp': params.get('t'),
        'wind': params.get('ws'),
        'symbol': params.get('Wsymb2'),
        'precip': params.get('pcat'),
        'valid_time': ts_entry['validTime'],
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
