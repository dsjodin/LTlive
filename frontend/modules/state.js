/**
 * state.js — Shared application state for all modules.
 *
 * Centralises mutable state so modules can import and mutate it without
 * circular dependencies.  Each module reads/writes fields directly on
 * this object rather than maintaining private copies.
 */

const state = {
    // Leaflet map instance (set by mapCore.init)
    map: null,

    // Configuration (overridden by /api/status at startup)
    POLL_INTERVAL: 5000,
    MAP_CENTER: [59.2753, 15.2134],  // default; replaced by /api/status
    MAP_ZOOM: 13,
    siteName: "",
    features: {},
    nearbyRadius: 400,

    // Dark mode
    darkMode: localStorage.getItem("darkMode") === "true",

    // Layers
    tileLayer: null,
    stopsLayer: null,
    stopsLoaded: false,
    routesLoaded: false,

    // Route data
    routeData: {},        // route_id -> route object
    routeLayers: {},      // route_id -> L.polyline

    // Vehicles
    vehicleMarkers: {},   // vehicle_id -> L.marker
    vehicleAnim: {},      // vehicle_id -> animation state
    vehicleLastBearing: {},
    vehicleTrailPoints: {},
    vehicleTrails: {},

    // Stops
    stopMarkerMap: {},    // stop_id -> L.marker
    stopNextDep: {},      // stop_id -> next departure info

    // Filters
    activeFilters: new Set(),
    hiddenTypes: new Set(),
    showStops: true,
    showRoutes: true,
    showLabels: true,

    // Line panel
    activePanelRouteId: null,
    linePanelTimer: null,

    // Favorites
    favoriteStops: new Map(),
    savedTrips: new Map(),
    favoritesTimer: null,

    // Nearby / GPS
    userMarker: null,
    userAccCircle: null,
    geoWatchId: null,
    nearbyPanelOpen: false,
    nearbyTimer: null,
    lastNearbyPos: null,

    // SSE
    sseSource: null,
    sseFallbackTimer: null,
    _vehicleState: new Map(),
    _deltaReady: false,

    // Train routes
    trainRailLayer: null,
    trainRoutesLoaded: false,
    trainShapeCoords: [],

    // Vehicle animation
    animFrameId: null,

    // Traffic
    trafficLayer: null,
    showTraffic: false,
    _trafficTimer: null,
    zoneLayer: null,
    showZones: false,

    // Dashboard
    _dashAlerts: [],

    // ETA
    etaTimer: null,

    // Weather
    _lastWeather: null,

    // Constants
    TRAIL_MAX_POINTS: 10,
    BADGE_MIN_ZOOM: 15,
};

// Load favorites from localStorage
try {
    const saved = JSON.parse(localStorage.getItem("favoriteStops") || "[]");
    saved.forEach(s => state.favoriteStops.set(s.stop_id, s));
} catch (_) {}

// Load saved trips from localStorage
try {
    const saved = JSON.parse(localStorage.getItem("savedTrips") || "[]");
    saved.forEach(t => state.savedTrips.set(`${t.route_short_name}::${t.stop_id}`, t));
} catch (_) {}

export default state;
