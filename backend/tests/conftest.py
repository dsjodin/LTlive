"""Shared fixtures for LTlive backend tests."""

import os
import sys
import pytest

# Ensure backend modules are importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set required env vars before any config import
os.environ.setdefault("OPERATOR", "test")
os.environ.setdefault("TRAFIKLAB_API_KEY", "test-key")
os.environ.setdefault("ENABLE_DEBUG_ENDPOINTS", "false")
os.environ.setdefault("TRAFFIC_ENABLED", "false")


@pytest.fixture
def app():
    """Create a Flask test app."""
    from app import app as flask_app
    flask_app.config["TESTING"] = True
    return flask_app


@pytest.fixture
def client(app):
    """Create a Flask test client."""
    return app.test_client()
