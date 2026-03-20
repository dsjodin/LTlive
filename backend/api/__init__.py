# Flask Blueprint package for LTlive API endpoints.
#
# Blueprints:
#   debug          — /api/debug/*           (protected, LAN only)
#   vehicles       — /api/vehicles, /api/stream
#   departures     — /api/departures, /api/arrivals, /api/station-messages
#   stops          — /api/stops*, /api/nearby-departures
#   routes_shapes  — /api/routes*, /api/shapes*
#   status         — /api/health, /api/status, /api/alerts, /api/line*, /api/stats*
