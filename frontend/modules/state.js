/**
 * state.js — Shared application state for LTlive.
 *
 * Centralises every mutable variable that is used across more than one
 * logical area, making the data model explicit and easy to reason about.
 *
 * Config values (MAP_CENTER, POLL_INTERVAL, …) start with sensible defaults
 * and are overwritten by the /api/status response during initialisation.
 */

// --- Backend-driven config ---
export let POLL_INTERVAL = 5000;
export let MAP_CENTER    = [59.2753, 15.2134];
export let MAP_ZOOM      = 13;
export let nearbyRadius  = 400;

export function applyStatusConfig(cfg) {
    if (cfg.frontend_poll_interval_ms) POLL_INTERVAL = cfg.frontend_poll_interval_ms;
    if (cfg.map_center_lat && cfg.map_center_lon) MAP_CENTER = [cfg.map_center_lat, cfg.map_center_lon];
    if (cfg.map_default_zoom)       MAP_ZOOM      = cfg.map_default_zoom;
    if (cfg.nearby_radius_meters)   nearbyRadius  = cfg.nearby_radius_meters;
}

// --- Persistent UI preferences ---
export let darkMode = localStorage.getItem("darkMode") === "true";

export function setDarkMode(value) {
    darkMode = value;
    localStorage.setItem("darkMode", value);
}

// --- Map objects ---
export let map          = null;
export let tileLayer    = null;
export let stopsLayer   = null;

export function setMap(m)        { map        = m; }
export function setTileLayer(t)  { tileLayer  = t; }
export function setStopsLayer(s) { stopsLayer = s; }

// --- Route / stop data ---
export let routeData   = {};   // route_id -> route object
export let routeLayers = {};   // route_id -> L.layerGroup
export let stopMarkerMap = {};  // stop_id  -> L.marker
export let stopNextDep   = {};  // stop_id  -> {minutes, route_short_name, …}

// --- Load flags ---
export let stopsLoaded  = false;
export let routesLoaded = false;

export function markStopsLoaded()  { stopsLoaded  = true; }
export function markRoutesLoaded() { routesLoaded = true; }

// --- Vehicle markers & animation ---
export const vehicleMarkers     = {};  // vehicle_id -> L.marker
export const vehicleAnim        = {};  // vehicle_id -> animation state
export const vehicleLastBearing = {};  // vehicle_id -> degrees
export const vehicleTrailPoints = {};  // vehicle_id -> [[lat,lon], …]
export const vehicleTrails      = {};  // vehicle_id -> L.polyline

// --- Active filters ---
export let activeFilters = new Set();  // route_id strings
export let hiddenTypes   = new Set();  // "bus" | "train"

// --- Display toggles ---
export let showStops  = true;
export let showRoutes = true;
export let showLabels = true;

// --- Line panel ---
export let activePanelRouteId = null;
export let linePanelTimer     = null;

// --- Nearby panel / GPS ---
export let userMarker     = null;
export let userAccCircle  = null;
export let geoWatchId     = null;
export let nearbyPanelOpen = false;
export let nearbyTimer     = null;
export let lastNearbyPos   = null;

// --- SSE stream ---
export let sseSource        = null;
export let sseFallbackTimer = null;

// --- Train rail layer ---
export let trainRailLayer    = null;
export let trainRoutesLoaded = false;
export const trainShapeCoords = [];  // [[lat,lon], …] arrays for bearing snap

// --- ETA countdown timer ---
export let etaTimer = null;
