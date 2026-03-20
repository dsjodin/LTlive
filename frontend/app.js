/**
 * LTlive - Live bus tracking for Örebro
 * Leaflet map with GTFS-RT vehicle positions
 */

import {
    fetchStatus, fetchVehicles, fetchAlerts,
    fetchRoutes, fetchTrainShapes,
    fetchStops, fetchNextDepartures, fetchDepartures,
    fetchShapeForRoute, fetchShapesBulk,
    fetchLineDepartures as apiFetchLineDepartures,
    fetchNearbyDepartures as apiFetchNearbyDepartures,
    connectSSE,
    fetchWeather,
} from "./modules/api.js";

const SMHI_ICONS = {
    1:'☀️', 2:'🌤️', 3:'⛅', 4:'🌥️', 5:'🌫️', 6:'🌫️',
    7:'🌦️', 8:'🌧️', 9:'🌧️', 10:'⛈️', 11:'⛈️', 12:'⛈️', 13:'⛈️',
    14:'🌨️', 15:'❄️', 16:'❄️', 17:'❄️', 18:'🌨️', 19:'🌨️',
    20:'❄️', 21:'❄️', 22:'❄️', 23:'❄️', 24:'🌨️', 25:'🌨️',
    26:'❄️', 27:'❄️',
};

async function updateWeather() {
    try {
        const w = await fetchWeather();
        document.getElementById('weather-temp').textContent =
            w.temp != null ? `${Math.round(w.temp)}°` : '--°';
        document.getElementById('weather-icon').textContent =
            SMHI_ICONS[w.symbol] ?? '🌡️';
    } catch (e) {
        console.warn('Weather update failed:', e);
    }
}

let POLL_INTERVAL = 5000;        // default, overridden by backend config via /api/status
let MAP_CENTER = [59.2753, 15.2134]; // default, overridden by backend config via /api/status
let MAP_ZOOM = 13;               // default, overridden by backend config via /api/status


// --- State ---
let map;
let vehicleMarkers = {};
let routeLayers = {};
let routeData = {};
let activeFilters = new Set();
let hiddenTypes = new Set(); // "bus" or "train"
let showStops = true;
let showRoutes = true;
let showLabels = true;
let darkMode = localStorage.getItem("darkMode") === "true";
let tileLayer = null;
let stopsLayer = null;
let stopsLoaded = false;
let routesLoaded = false;

// Line panel
let activePanelRouteId = null;
let linePanelTimer = null;

// Nearby panel / GPS
let userMarker = null;
let userAccCircle = null;
let geoWatchId = null;
let nearbyPanelOpen = false;
let nearbyTimer = null;
let lastNearbyPos = null;
let nearbyRadius = 400;

// Stop departure badges
let stopMarkerMap = {};   // stop_id -> L.marker
let stopNextDep = {};     // stop_id -> {minutes, route_short_name, route_color, route_text_color}
const BADGE_MIN_ZOOM = 15;

// Vehicle animation
const vehicleAnim = {};   // vehicle_id -> {fromLat, fromLon, toLat, toLon, startTime, duration}
let animFrameId = null;

// SSE stream
let sseSource = null;
let sseFallbackTimer = null;

// Last known bearing per vehicle — reused when train is stopped / bearing is null
const vehicleLastBearing = {};  // vehicle_id -> degrees

// Vehicle trails (breadcrumbs)
const vehicleTrailPoints = {};  // vehicle_id -> [[lat,lon], ...]
const vehicleTrails = {};       // vehicle_id -> L.polyline
const TRAIL_MAX_POINTS = 10;

// Live ETA countdown
let etaTimer = null;

// Favorite stops
let favoriteStops = new Map(); // stop_id -> {stop_name, stop_id}
try {
    const saved = JSON.parse(localStorage.getItem("favoriteStops") || "[]");
    saved.forEach(s => favoriteStops.set(s.stop_id, s));
} catch (_) {}
let favoritesTimer = null;

// Saved trips (line + stop combos)
let savedTrips = new Map(); // "${route_short_name}::${stop_id}" -> {route_id, route_short_name, route_color, route_text_color, stop_id, stop_name}
try {
    const saved = JSON.parse(localStorage.getItem("savedTrips") || "[]");
    saved.forEach(t => savedTrips.set(`${t.route_short_name}::${t.stop_id}`, t));
} catch (_) {}

const TILES = {
    dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
};

// --- Default line colors (fallback if GTFS has no color) ---
const LINE_COLORS = [
    "E63946", "457B9D", "2A9D8F", "E9C46A", "F4A261",
    "264653", "6A0572", "AB83A1", "118AB2", "073B4C",
    "D62828", "F77F00", "FCBF49", "2EC4B6", "011627",
    "FF6B6B", "4ECDC4", "45B7D1", "96CEB4", "FFEAA7",
];

function getLineStyle(shortName) {
    if (LINE_COLORS_CUSTOM[shortName]) return LINE_COLORS_CUSTOM[shortName];
    if (LINE_CONFIG.lansbuss.includes(shortName)) return LINE_COLORS_CUSTOM.lansbuss;
    return null;
}

function getRouteColor(route) {
    const custom = getLineStyle(route.route_short_name);
    if (custom) return `#${custom.bg}`;
    if (route.route_color && route.route_color !== "000000") {
        return `#${route.route_color}`;
    }
    const name = route.route_short_name || route.route_id;
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return `#${LINE_COLORS[Math.abs(hash) % LINE_COLORS.length]}`;
}

// Apply dynamic badge colors via JS after innerHTML assignment.
// Avoids inline style= HTML attributes, which are blocked by strict style-src CSP.
function applyBadgeColors(container) {
    container.querySelectorAll("[data-bg]").forEach(el => {
        el.style.background = el.dataset.bg.startsWith("#") ? el.dataset.bg : `#${el.dataset.bg}`;
        if (el.dataset.fg) el.style.color = el.dataset.fg.startsWith("#") ? el.dataset.fg : `#${el.dataset.fg}`;
    });
}

function getRouteTextColor(route) {
    const custom = getLineStyle(route.route_short_name);
    if (custom) return `#${custom.text}`;
    return route.route_text_color ? `#${route.route_text_color}` : "#fff";
}

// --- Map Init ---
function initMap() {
    map = L.map("map", {
        center: MAP_CENTER,
        zoom: MAP_ZOOM,
        zoomControl: true,
    });

    setTileLayer(darkMode);
    document.body.classList.toggle("light-mode", !darkMode);
    const dmToggle = document.getElementById("toggle-darkmode");
    if (dmToggle) dmToggle.checked = darkMode;

    map.on("popupopen", () => startEtaCountdown());
    map.on("popupclose", () => { clearInterval(etaTimer); etaTimer = null; });

    // Rescale icons when zoom changes
    map.on("zoomend", () => {
        Object.values(vehicleMarkers).forEach(m => {
            if (m._vehicleData) m.setIcon(createVehicleIcon(m._vehicleData));
        });
        updateStopBadges();
    });
}

// --- Driftsplats overlay (debug) ---
// Visualises the approximate operational boundary (driftsplatsgräns) for Örebro C (Örc).
// Trafikverket's TimeAtLocation fires at this boundary, NOT at the platform.
// The northern entry signal "Ör 121" (~59.2995°N) is why northbound trains show
// "Ankommit" ~1.7 km before they reach the platform.
// Activate with ?debug in the URL.
function addDriftsplatsOverlay() {
    // Approximate polygon derived from OSM signal/buffer-stop positions
    L.polygon([
        [59.2660, 15.1950],  // SW corner
        [59.2660, 15.2440],  // SE corner
        [59.3000, 15.2220],  // N — entry signal Ör 121
        [59.3000, 15.1960],  // NW corner
    ], {
        color: "#f59e0b",
        weight: 2,
        dashArray: "6 4",
        fillColor: "#f59e0b",
        fillOpacity: 0.06,
        interactive: false,
    }).addTo(map).bindTooltip("Örc driftsplats — ungefärlig gräns (baserad på OSM-signalpositioner)", { sticky: true });

    // Mark the northern entry signal — the actual TimeAtLocation trigger point for northbound trains
    L.circleMarker([59.2995, 15.2215], {
        radius: 7,
        color: "#ef4444",
        fillColor: "#ef4444",
        fillOpacity: 0.9,
        weight: 2,
    }).addTo(map).bindTooltip("Infartssignal Ör 121 — TimeAtLocation triggas här för tåg norrifrån");

    // Show the 600 m GPS arrival-confirmation radius used by the backend
    L.circle(MAP_CENTER, {
        radius: 600,
        color: "#22c55e",
        weight: 2,
        dashArray: "4 4",
        fillColor: "#22c55e",
        fillOpacity: 0.05,
        interactive: false,
    }).addTo(map).bindTooltip("600 m GPS-tröskel (gps_at_station i backend)");
}

function setTileLayer(isDark) {
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(isDark ? TILES.dark : TILES.light, {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | Data: <a href="https://trafiklab.se">Trafiklab</a>',
        subdomains: "abcd",
        maxZoom: 19,
    });
    tileLayer.addTo(map);
}

// --- Bus markers ---

// Returns a border colour for the vehicle marker based on schedule deviation.
// white  = on time / unknown (delay_seconds null or ≤60 s)
// yellow = slightly late (1–5 min)
// red    = significantly late (>5 min)
function getDelayBorderColor(vehicle) {
    const d = vehicle.delay_seconds;
    if (d == null || d <= 60) return "white";
    if (d <= 300) return "#FFD600";
    return "#F44336";
}

function getDelayClass(vehicle) {
    const d = vehicle.delay_seconds;
    if (d == null || d <= 60) return "";
    if (d <= 300) return " delay-warning";
    return " delay-critical";
}

// Icon size varies with zoom level so buses don't dominate zoomed-out views.
function getIconR() {
    const zoom = map ? map.getZoom() : 14;
    if (zoom <= 12) return 5;
    if (zoom <= 13) return 8;
    if (zoom <= 14) return 11;
    return 13;
}

function createBusIcon(vehicle) {
    const color = getRouteColor({
        route_color: vehicle.route_color,
        route_short_name: vehicle.route_short_name,
        route_id: vehicle.route_id,
    });
    const textColor = getRouteTextColor(vehicle);
    const label = vehicle.route_short_name || "";
    const bearing = vehicle.bearing;
    const hasBearing = bearing != null;
    // Grow circle radius for longer line numbers so digits don't overflow
    const R = getIconR() + (label.length >= 3 ? 4 : label.length >= 2 ? 1 : 0);

    if (!showLabels || !label || R <= 6) {
        // Tiny dot at low zoom / labels off — use DOM element to avoid inline style=
        const d = R * 2;
        const dot = document.createElement("div");
        dot.className = "bus-icon-inner" + getDelayClass(vehicle);
        dot.style.width        = `${d}px`;
        dot.style.height       = `${d}px`;
        dot.style.borderRadius = "50%";
        dot.style.background   = color;
        dot.style.border       = `2px solid ${getDelayBorderColor(vehicle)}`;
        dot.style.boxShadow    = "0 1px 4px rgba(0,0,0,.5)";
        return L.divIcon({
            className: "bus-icon-wrapper",
            html: dot,
            iconSize: [d, d],
            iconAnchor: [R, R],
        });
    }

    // Circle with directional arrowhead (SVG)
    const TIP = Math.round(R * 0.65);
    const W = (R + TIP) * 2;
    const CX = W / 2, CY = W / 2;
    const fs = Math.round(R * (label.length >= 3 ? 0.72 : label.length >= 2 ? 0.9 : 1.1));

    const borderColor = getDelayBorderColor(vehicle);
    const tipPath = hasBearing
        ? `<path d="M ${CX},${CY-R-TIP} L ${CX+Math.round(TIP*0.65)},${CY-R+Math.round(TIP*0.45)} L ${CX-Math.round(TIP*0.65)},${CY-R+Math.round(TIP*0.45)} Z"
                  fill="${color}" stroke="${borderColor}" stroke-width="2" stroke-linejoin="round"/>`
        : "";

    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" class="vehicle-svg">
      <g transform="rotate(${hasBearing ? bearing : 0},${CX},${CY})">
        ${tipPath}
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="${color}" stroke="${borderColor}" stroke-width="2.5"/>
      </g>
      <text x="${CX}" y="${CY}" text-anchor="middle" dominant-baseline="central"
            font-size="${fs}" font-weight="800" fill="${textColor}"
            font-family="-apple-system,BlinkMacSystemFont,sans-serif"
            class="vehicle-svg-label">${label}</text>
    </svg>`;

    return L.divIcon({
        className: "bus-icon-wrapper",
        html: `<div class="bus-icon-inner icon-shadow${getDelayClass(vehicle)}">${svg}</div>`,
        iconSize: [W, W],
        iconAnchor: [CX, CY],
    });
}

// Train icon — horizontal [carriage2][carriage1][locomotive>] shape.
// Pivot = locomotive center. Nose points RIGHT by default → rotate(bearing−90) to align north.
// Label stays upright on the locomotive at all headings.
function createTrainIcon(vehicle) {
    const color     = `#${vehicle.route_color      || "E87722"}`;
    const textColor = `#${vehicle.route_text_color || "FFFFFF"}`;
    // Prefer advertised trip label; fall back to vehicleId prefix ("9005" from "9005.trains.se")
    const label   = vehicle.label || (vehicle.vehicle_id || "").split(".")[0] || "";
    const bearing  = vehicle.bearing;
    const hasBearing = bearing != null;
    const zoom = map.getZoom();

    if (zoom <= 12) {
        const d = 10;
        const dot = document.createElement("div");
        dot.style.width        = `${d}px`;
        dot.style.height       = `${d}px`;
        dot.style.borderRadius = "2px";
        dot.style.background   = color;
        dot.style.border       = "2px solid white";
        dot.style.boxShadow    = "0 1px 4px rgba(0,0,0,.5)";
        return L.divIcon({
            className: "bus-icon-wrapper",
            html: dot,
            iconSize: [d, d],
            iconAnchor: [d / 2, d / 2],
        });
    }

    // Canvas: 100×100, locomotive centered at (cx,cy)=(50,50)
    const W = 100, cx = 50, cy = 50;

    const lW = 36, lH = 16;   // locomotive
    const cW = 24, cH = 12;   // carriage
    const gap = 4;             // gap between cars
    const noseLen = 8;         // nose length
    const noseHH  = 7;         // nose half-height
    const rx = 4;              // corner radius
    const outlineColor = "#2A1010";

    const lx   = cx - lW / 2;           // loco left edge  = 32
    const ly   = cy - lH / 2;           // loco top  edge  = 42
    const c1x  = lx - gap - cW;         // carriage-1 left = 4
    const c2x  = c1x - gap - cW;        // carriage-2 left = −24 (overflow:visible)
    const cy_c = cy - cH / 2;           // carriage top    = 44
    const noseBaseX = lx + lW;          // nose base x     = 68
    const noseTipX  = noseBaseX + noseLen; // nose tip x   = 76

    const stationary  = !!vehicle._stationary;
    const locoFill    = stationary ? "#888888" : color;
    const carriageFill = stationary ? "#666666" : "#5C3030";
    const textFill    = stationary ? "#FFFFFF" : textColor;
    const outline     = stationary ? "#444444" : outlineColor;
    const rotation    = hasBearing ? bearing - 90 : 0;
    const fs = label.length >= 4 ? 11 : label.length >= 3 ? 13 : 15;

    const noseSvg = stationary ? "" : `
    <path d="M ${noseTipX},${cy} L ${noseBaseX},${cy - noseHH} L ${noseBaseX},${cy + noseHH} Z"
          fill="${locoFill}" stroke="${outline}" stroke-width="2" stroke-linejoin="round"/>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" class="vehicle-svg">
  <g transform="rotate(${rotation},${cx},${cy})">
    <rect x="${c2x}" y="${cy_c}" width="${cW}" height="${cH}" rx="${rx}" ry="${rx}"
          fill="${carriageFill}" stroke="${outline}" stroke-width="2"/>
    <rect x="${c1x}" y="${cy_c}" width="${cW}" height="${cH}" rx="${rx}" ry="${rx}"
          fill="${carriageFill}" stroke="${outline}" stroke-width="2"/>
    <rect x="${lx}" y="${ly}" width="${lW}" height="${lH}" rx="${rx}" ry="${rx}"
          fill="${locoFill}" stroke="${outline}" stroke-width="2"/>${noseSvg}
  </g>
  <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
        font-size="${fs}" font-weight="800" fill="${textFill}"
        font-family="-apple-system,BlinkMacSystemFont,sans-serif"
        class="vehicle-svg-label">${label}</text>
</svg>`;

    return L.divIcon({
        className: "bus-icon-wrapper",
        html: `<div class="bus-icon-inner icon-shadow">${svg}</div>`,
        iconSize: [W, W],
        iconAnchor: [cx, cy],
    });
}

// Dispatch to bus or train icon based on vehicle_type.
function createVehicleIcon(vehicle) {
    return vehicle.vehicle_type === "train" ? createTrainIcon(vehicle) : createBusIcon(vehicle);
}

// Update bearing in-place without recreating the DOM element (avoids click flicker).
function updateBusIconBearing(marker, bearing) {
    const el = marker.getElement();
    const g = el && el.querySelector("svg > g");
    if (!g) return;
    const svg = el.querySelector("svg");
    const W = svg ? parseFloat(svg.getAttribute("width")) : 0;
    if (!W) return;
    const CX = W / 2;
    // Trains: nose points RIGHT by default → subtract 90° to align with north-up bearing
    const isTrain = marker._vehicleData && marker._vehicleData.vehicle_type === "train";
    const rotation = isTrain ? bearing - 90 : bearing;
    g.setAttribute("transform", `rotate(${rotation},${CX},${CX})`);
}

// Calculate distance in meters between two lat/lon points (Haversine)
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Smooth cubic ease-in-out
function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function startAnimLoop() {
    if (animFrameId) return;
    function frame(ts) {
        let hasActive = false;
        Object.entries(vehicleAnim).forEach(([id, anim]) => {
            const marker = vehicleMarkers[id];
            if (!marker) { delete vehicleAnim[id]; return; }
            const raw = Math.min(1, (ts - anim.startTime) / anim.duration);
            const t = easeInOut(raw);
            const lat = anim.fromLat + (anim.toLat - anim.fromLat) * t;
            const lon = anim.fromLon + (anim.toLon - anim.fromLon) * t;
            marker.setLatLng([lat, lon]);
            if (raw < 1) hasActive = true;
            else delete vehicleAnim[id];
        });
        animFrameId = hasActive ? requestAnimationFrame(frame) : null;
    }
    animFrameId = requestAnimationFrame(frame);
}

function updateVehicles(vehicles) {
    const currentIds = new Set();
    const now = Date.now() / 1000;

    vehicles.forEach((v) => {
        const id = v.vehicle_id || v.id;
        currentIds.add(id);

        // Skip vehicles not in our configured lines
        // Trains: filter by vehicleId prefix against ALLOWED_TRAIN_IDS.
        // TV-sourced trains (vehicle_id starts with "tv_") bypass the Oxyfi
        // prefix filter — they're already geo-filtered server-side and include
        // operators like Mälartåg and SJ that have no Oxyfi vehicle IDs.
        // Buses: filter by route_short_name against ALLOWED_LINE_NUMBERS
        const isTvTrain = v.vehicle_type === "train" && (v.vehicle_id || "").startsWith("tv_");
        const trainIdPrefix = v.vehicle_type === "train" ? (v.vehicle_id || "").split(".")[0] : null;
        if (isTvTrain ? false
                      : v.vehicle_type === "train" ? (ALLOWED_TRAIN_IDS.size > 0 && !ALLOWED_TRAIN_IDS.has(trainIdPrefix))
                                                   : (ALLOWED_LINE_NUMBERS.size > 0 && !ALLOWED_LINE_NUMBERS.has(v.route_short_name))) {
            if (vehicleMarkers[id]) {
                map.removeLayer(vehicleMarkers[id]);
                delete vehicleMarkers[id];
            }
            return;
        }

        if (activeFilters.size > 0 && !activeFilters.has(v.route_id)) {
            if (vehicleMarkers[id]) {
                map.removeLayer(vehicleMarkers[id]);
                delete vehicleMarkers[id];
            }
            return;
        }

        const vType = v.vehicle_type === "train" ? "train" : "bus";
        if (hiddenTypes.has(vType)) {
            if (vehicleMarkers[id]) {
                map.removeLayer(vehicleMarkers[id]);
                delete vehicleMarkers[id];
            }
            return;
        }

        const latlng = [v.lat, v.lon];

        // Calculate speed from position delta if feed doesn't provide it
        if (v.speed == null && vehicleMarkers[id] && vehicleMarkers[id]._vehicleData) {
            const prev = vehicleMarkers[id]._vehicleData;
            const dt = (v.timestamp || now) - (prev.timestamp || prev._localTime || 0);
            if (dt > 0 && dt < 120) {
                const dist = haversineDistance(prev.lat, prev.lon, v.lat, v.lon);
                if (dist > 2) { // Ignore GPS jitter under 2m
                    v._calculatedSpeed = dist / dt; // m/s
                }
            }
        }
        v._localTime = now;

        // For trains: determine stationary state and set display bearing
        if (v.vehicle_type === "train") {
            const speed = v.speed ?? v._calculatedSpeed ?? 0;
            const moving = speed > 0.5 && v.bearing != null;
            if (moving) {
                vehicleLastBearing[id] = v.bearing;
                v._stationary = false;
            } else {
                v._stationary = true;
                // Snap to nearest track segment when shape data is loaded
                if (trainShapeCoords.length > 0) {
                    v.bearing = snapBearingToTrack(v.lat, v.lon);
                } else {
                    v.bearing = vehicleLastBearing[id] ?? null;
                }
            }
        }

        if (vehicleMarkers[id]) {
            // Animate to new position instead of jumping
            const cur = vehicleMarkers[id].getLatLng();
            const dist = haversineDistance(cur.lat, cur.lng, v.lat, v.lon);
            if (dist > 1) { // ignore GPS jitter
                vehicleAnim[id] = {
                    fromLat: cur.lat, fromLon: cur.lng,
                    toLat: v.lat, toLon: v.lon,
                    startTime: performance.now(),
                    duration: Math.min(POLL_INTERVAL * 0.95, 4000),
                };
                startAnimLoop();
            }

            // Update trail
            if (!vehicleTrailPoints[id]) vehicleTrailPoints[id] = [];
            vehicleTrailPoints[id].push([v.lat, v.lon]);
            if (vehicleTrailPoints[id].length > TRAIL_MAX_POINTS) vehicleTrailPoints[id].shift();
            const trailColor = getRouteColor({ route_color: v.route_color, route_short_name: v.route_short_name, route_id: v.route_id });
            if (vehicleTrails[id] && vehicleTrailPoints[id].length >= 2) {
                vehicleTrails[id].setLatLngs(vehicleTrailPoints[id]);
            } else if (!vehicleTrails[id] && vehicleTrailPoints[id].length >= 2) {
                vehicleTrails[id] = L.polyline(vehicleTrailPoints[id], {
                    color: trailColor, weight: 3, opacity: 0.45, dashArray: "4 5",
                }).addTo(map);
            }

            const prev = vehicleMarkers[id]._vehicleData;
            const colorChanged = !prev || prev.route_short_name !== v.route_short_name ||
                                 prev.route_color !== v.route_color;
            if (colorChanged) {
                vehicleMarkers[id].setIcon(createVehicleIcon(v));
            } else if (v.bearing != null) {
                // Rotate the existing SVG in-place — avoids DOM recreation and click flicker
                updateBusIconBearing(vehicleMarkers[id], v.bearing);
            }
        } else {
            const marker = L.marker(latlng, {
                icon: createVehicleIcon(v),
                zIndexOffset: 1000,
            });
            marker.on("click", () => {
                const current = marker._vehicleData || v;
                showVehiclePopup(current, marker);
            });
            marker.addTo(map);
            vehicleMarkers[id] = marker;
        }

        vehicleMarkers[id]._vehicleData = v;
    });

    // Remove markers that are no longer in the feed.
    // Trains report position rarely — keep them for 5 min after last seen.
    // Buses are removed as soon as they leave the feed (max 60 s grace).
    Object.keys(vehicleMarkers).forEach((id) => {
        if (currentIds.has(id)) return;
        const data = vehicleMarkers[id]._vehicleData;
        const isTrain = data && data.vehicle_type === "train";
        const staleAfter = isTrain ? 300 : 60;
        const lastSeen = (data && data._localTime) || 0;
        if (now - lastSeen < staleAfter) return; // keep it a while longer
        map.removeLayer(vehicleMarkers[id]);
        delete vehicleMarkers[id];
        delete vehicleAnim[id];
        delete vehicleLastBearing[id];
        delete vehicleTrailPoints[id];
        if (vehicleTrails[id]) { map.removeLayer(vehicleTrails[id]); delete vehicleTrails[id]; }
    });

    document.getElementById("vehicle-count").textContent = vehicles.length;
    document.getElementById("last-update").textContent = new Date().toLocaleTimeString("sv-SE");
    updateDashboard(vehicles);
}

// --- Stop departure board ---
function buildStopDepartureRows(stop, data) {
    if (!data || !data.departures || data.departures.length === 0) return null;
    const now = Date.now() / 1000;
    return data.departures.map((d) => {
        const secs = Math.round(d.departure_time - now);
        const mins = Math.floor(secs / 60);
        const remSecs = secs % 60;
        const timeStr = secs <= 0 ? "Nu"
            : mins > 0 ? `${mins} min ${String(remSecs).padStart(2,"0")} s`
            : `${secs} s`;
        const clock = new Date(d.departure_time * 1000)
            .toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
        const custom = getLineStyle(d.route_short_name);
        const bg = custom ? `#${custom.bg}` : `#${d.route_color}`;
        const fg = custom ? `#${custom.text}` : `#${d.route_text_color}`;
        const rt = d.is_realtime
            ? '<span class="dep-rt" title="Realtid">RT</span>'
            : "";
        const delay = d.delay_minutes || 0;
        const delayHtml = d.is_realtime
            ? (delay > 0
                ? `<span class="dep-delay late" title="Försenad">+${delay}</span>`
                : delay < 0
                    ? `<span class="dep-delay early" title="Tidig">${delay}</span>`
                    : `<span class="dep-delay ontime" title="I tid">✓</span>`)
            : "";
        const tripKey = `${d.route_short_name}::${stop.stop_id}`;
        const isSaved = savedTrips.has(tripKey);
        const pinBtn = `<button class="save-trip-btn${isSaved ? " active" : ""}"
            data-route-id="${d.route_id}"
            data-route-short="${d.route_short_name}"
            data-route-color="${d.route_color || ''}"
            data-route-text-color="${d.route_text_color || ''}"
            data-stop-id="${stop.stop_id}"
            data-stop-name="${stop.stop_name}"
            title="${isSaved ? "Ta bort sparad resa" : "Spara resa"}">📌</button>`;
        return `
            <tr>
                <td><span class="dep-badge" data-bg="${bg}" data-fg="${fg}">${d.route_short_name}</span></td>
                <td class="dep-headsign">${d.headsign}</td>
                <td class="dep-time"><span class="dep-countdown" data-ts="${d.departure_time}">${timeStr}</span>${rt}${delayHtml}</td>
                <td class="dep-clock">${clock}</td>
                <td class="dep-pin">${pinBtn}</td>
            </tr>`;
    }).join("");
}

function bindStopDepartureEvents(el, stop) {
    applyBadgeColors(el);
    el.querySelectorAll(".fav-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleFavorite(stop);
            btn.classList.toggle("active", favoriteStops.has(stop.stop_id));
            btn.title = favoriteStops.has(stop.stop_id) ? "Ta bort favorit" : "Spara som favorit";
        });
    });
    el.querySelectorAll(".share-btn").forEach(btn => bindShareBtn(btn, stop));
    el.querySelectorAll(".save-trip-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleSavedTrip(
                btn.dataset.routeId, btn.dataset.routeShort,
                btn.dataset.routeColor, btn.dataset.routeTextColor,
                btn.dataset.stopId, btn.dataset.stopName
            );
            const key = `${btn.dataset.routeShort}::${btn.dataset.stopId}`;
            btn.classList.toggle("active", savedTrips.has(key));
            btn.title = savedTrips.has(key) ? "Ta bort sparad resa" : "Spara resa";
        });
    });
}

function bindShareBtn(btn, stop) {
    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const url = `${location.origin}/busboard.html?stop_id=${encodeURIComponent(stop.stop_id)}&stop_name=${encodeURIComponent(stop.stop_name)}`;
        try {
            await navigator.clipboard.writeText(url);
            btn.textContent = "✓";
            setTimeout(() => { btn.textContent = "🔗"; }, 1500);
        } catch {}
    });
}

function showStopDepartures(stop, marker) {
    // On mobile: use bottom sheet panel instead of Leaflet popup
    if (window.innerWidth <= 600) {
        openStopPanel(stop);
        fetchDepartures(stop.stop_id)
            .then(data => populateStopPanel(stop, data))
            .catch(() => populateStopPanel(stop, null));
        return;
    }

    const loadingHtml = `
        <div class="popup-stop">
            <div class="popup-stop-name">${stop.stop_name}</div>
            <div class="dep-loading">Hämtar avgångar…</div>
        </div>`;
    marker.setPopupContent(loadingHtml);

    fetchDepartures(stop.stop_id)
        .then((data) => {
            let html;
            const rows = buildStopDepartureRows(stop, data);
            if (!rows) {
                html = `
                    <div class="popup-stop">
                        <div class="popup-stop-name">${stop.stop_name}</div>
                        <div class="dep-empty">Inga kommande avgångar</div>
                    </div>`;
            } else {
                const platformChip = stop.platform_code
                    ? `<span class="popup-platform">Läge ${stop.platform_code}</span>`
                    : "";
                const isFav = favoriteStops.has(stop.stop_id);
                const favBtn = `<button class="fav-btn${isFav ? " active" : ""}" data-stop-id="${stop.stop_id}" title="${isFav ? "Ta bort favorit" : "Spara som favorit"}">★</button>`;
                const shareBtn = `<button class="share-btn" title="Kopiera länk">🔗</button>`;
                html = `
                    <div class="popup-stop">
                        <div class="popup-stop-name">${stop.stop_name}${platformChip}
                            ${favBtn}${shareBtn}
                            <a class="board-link" href="/busboard.html?stop_id=${encodeURIComponent(stop.stop_id)}&stop_name=${encodeURIComponent(stop.stop_name)}" target="_blank" title="Öppna avgångstavla">&#128507;</a>
                        </div>
                        <table class="dep-table"><tbody>${rows}</tbody></table>
                    </div>`;
            }
            if (marker.isPopupOpen()) {
                marker.setPopupContent(html);
                const popup = marker.getPopup();
                if (popup) {
                    const el = popup.getElement();
                    if (el) bindStopDepartureEvents(el, stop);
                }
            }
        })
        .catch(() => {
            if (marker.isPopupOpen()) {
                marker.setPopupContent(`
                    <div class="popup-stop">
                        <div class="popup-stop-name">${stop.stop_name}</div>
                        <div class="dep-empty">Kunde inte hämta avgångar</div>
                    </div>`);
            }
        });
}

function openStopPanel(stop) {
    const panel = document.getElementById("stop-panel");
    const title = document.getElementById("stop-panel-title");
    const actions = document.getElementById("stop-panel-actions");
    const body = document.getElementById("stop-panel-body");
    const platformChip = stop.platform_code
        ? ` <span class="popup-platform">Läge ${stop.platform_code}</span>`
        : "";
    title.innerHTML = `${stop.stop_name}${platformChip}`;
    const isFav = favoriteStops.has(stop.stop_id);
    actions.innerHTML = `
        <button class="fav-btn${isFav ? " active" : ""}" data-stop-id="${stop.stop_id}" title="${isFav ? "Ta bort favorit" : "Spara som favorit"}">★</button>
        <button class="share-btn" title="Kopiera länk">🔗</button>
        <a class="board-link" href="/busboard.html?stop_id=${encodeURIComponent(stop.stop_id)}&stop_name=${encodeURIComponent(stop.stop_name)}" target="_blank" title="Öppna avgångstavla">&#128507;</a>`;
    body.innerHTML = `<div class="dep-loading" style="padding:14px">Hämtar avgångar…</div>`;
    // bind fav + share in header
    actions.querySelectorAll(".fav-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleFavorite(stop);
            btn.classList.toggle("active", favoriteStops.has(stop.stop_id));
            btn.title = favoriteStops.has(stop.stop_id) ? "Ta bort favorit" : "Spara som favorit";
        });
    });
    actions.querySelectorAll(".share-btn").forEach(btn => bindShareBtn(btn, stop));
    panel.classList.add("open");
    document.body.classList.add("stop-open");
    setTimeout(() => map.invalidateSize(), 310);
}

function closeStopPanel() {
    document.getElementById("stop-panel").classList.remove("open");
    document.body.classList.remove("stop-open");
    setTimeout(() => map.invalidateSize(), 310);
}

function populateStopPanel(stop, data) {
    const body = document.getElementById("stop-panel-body");
    if (!document.getElementById("stop-panel").classList.contains("open")) return;
    const rows = buildStopDepartureRows(stop, data);
    if (!rows) {
        body.innerHTML = `<div class="dep-empty" style="padding:14px">Inga kommande avgångar</div>`;
        return;
    }
    body.innerHTML = `<table class="dep-table" style="width:100%;padding:0 14px;box-sizing:border-box"><tbody>${rows}</tbody></table>`;
    bindStopDepartureEvents(body, stop);
}

function startEtaCountdown() {
    clearInterval(etaTimer);
    etaTimer = setInterval(() => {
        const now = Date.now() / 1000;
        document.querySelectorAll(".dep-countdown").forEach(el => {
            const ts = parseFloat(el.dataset.ts);
            const secs = Math.round(ts - now);
            if (secs <= 0) { el.textContent = "Nu"; return; }
            const m = Math.floor(secs / 60);
            const s = secs % 60;
            el.textContent = m > 0 ? `${m} min ${String(s).padStart(2,"0")} s` : `${secs} s`;
        });
    }, 1000);
}

// --- Favorite stops ---
function saveFavorites() {
    localStorage.setItem("favoriteStops", JSON.stringify([...favoriteStops.values()]));
}

// --- Saved trips ---
function saveSavedTrips() {
    localStorage.setItem("savedTrips", JSON.stringify([...savedTrips.values()]));
}

function toggleSavedTrip(route_id, route_short_name, route_color, route_text_color, stop_id, stop_name) {
    const key = `${route_short_name}::${stop_id}`;
    if (savedTrips.has(key)) {
        savedTrips.delete(key);
    } else {
        savedTrips.set(key, { route_id, route_short_name, route_color, route_text_color, stop_id, stop_name });
    }
    saveSavedTrips();
    renderFavoritesPanel();
}

function toggleFavorite(stop) {
    if (favoriteStops.has(stop.stop_id)) {
        favoriteStops.delete(stop.stop_id);
    } else {
        favoriteStops.set(stop.stop_id, { stop_id: stop.stop_id, stop_name: stop.stop_name });
    }
    saveFavorites();
    renderFavoritesPanel();
}

function renderFavoritesPanel() {
    const panel = document.getElementById("favorites-panel");
    const body = document.getElementById("favorites-panel-body");
    if (!panel || !body) return;

    let html = "";

    // --- Stops section ---
    html += `<div class="fav-section">`;
    html += `<div class="fav-section-title">★ Hållplatser</div>`;
    if (favoriteStops.size === 0) {
        html += `<div class="fav-empty">Inga favorithållplatser ännu.<br>Klicka på ★ i en hållplats-popup för att spara.</div>`;
    } else {
        html += [...favoriteStops.values()].map(s => `
            <div class="fav-stop" data-stop-id="${s.stop_id}">
                <span class="fav-stop-name">${s.stop_name}</span>
                <div class="fav-stop-deps" id="fav-deps-${s.stop_id}">
                    <span class="fav-loading">Hämtar…</span>
                </div>
            </div>`).join("");
    }
    html += `</div>`;

    // --- Saved trips section ---
    html += `<div class="fav-section">`;
    html += `<div class="fav-section-title">📌 Mina resor</div>`;
    if (savedTrips.size === 0) {
        html += `<div class="fav-empty">Inga sparade resor ännu.<br>Klicka på 📌 vid en avgång för att spara.</div>`;
    } else {
        html += [...savedTrips.entries()].map(([key, t]) => {
            const custom = getLineStyle(t.route_short_name);
            const bg = custom ? `#${custom.bg}` : (t.route_color ? `#${t.route_color}` : "#555");
            const fg = custom ? `#${custom.text}` : (t.route_text_color ? `#${t.route_text_color}` : "#fff");
            const safeKey = key.replace(/::/g, "-");
            return `
            <div class="saved-trip-card" data-key="${key}">
                <span class="fav-dep-badge" style="background:${bg};color:${fg};flex-shrink:0">${t.route_short_name}</span>
                <div class="saved-trip-info">
                    <div class="saved-trip-label">från ${t.stop_name}</div>
                    <div class="fav-stop-deps" id="trip-deps-${safeKey}"><span class="fav-loading">Hämtar…</span></div>
                </div>
                <button class="saved-trip-remove" data-key="${key}" title="Ta bort">✕</button>
            </div>`;
        }).join("");
    }
    html += `</div>`;

    body.innerHTML = html;

    // Bind remove-trip buttons
    body.querySelectorAll(".saved-trip-remove").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            savedTrips.delete(btn.dataset.key);
            saveSavedTrips();
            renderFavoritesPanel();
        });
    });

    fetchFavoriteDepartures();
    fetchSavedTripDepartures();
}

function fetchFavoriteDepartures() {
    favoriteStops.forEach(s => {
        fetchDepartures(s.stop_id, 3).then(data => {
            const el = document.getElementById(`fav-deps-${s.stop_id}`);
            if (!el) return;
            if (!data.departures || data.departures.length === 0) {
                el.innerHTML = `<span class="fav-empty-deps">Inga avgångar</span>`;
                return;
            }
            const now = Date.now() / 1000;
            el.innerHTML = data.departures.map(d => {
                const mins = Math.max(0, Math.round((d.departure_time - now) / 60));
                const timeStr = mins === 0 ? "Nu" : `${mins} min`;
                const custom = getLineStyle(d.route_short_name);
                const bg = custom ? `#${custom.bg}` : `#${d.route_color}`;
                const fg = custom ? `#${custom.text}` : `#${d.route_text_color}`;
                return `<span class="fav-dep">
                    <span class="fav-dep-badge" style="background:${bg};color:${fg}">${d.route_short_name}</span>
                    <span class="fav-dep-headsign">${d.headsign}</span>
                    <span class="fav-dep-time">${timeStr}</span>
                </span>`;
            }).join("");
        }).catch(() => {
            const el = document.getElementById(`fav-deps-${s.stop_id}`);
            if (el) el.innerHTML = `<span class="fav-empty-deps">Fel</span>`;
        });
    });
}

function fetchSavedTripDepartures() {
    savedTrips.forEach((trip, key) => {
        const safeKey = key.replace(/::/g, "-");
        fetchDepartures(trip.stop_id, 8).then(data => {
            const el = document.getElementById(`trip-deps-${safeKey}`);
            if (!el) return;
            const filtered = (data.departures || []).filter(d => d.route_short_name === trip.route_short_name);
            if (filtered.length === 0) {
                el.innerHTML = `<span class="fav-empty-deps">Inga avgångar</span>`;
                return;
            }
            const now = Date.now() / 1000;
            el.innerHTML = filtered.slice(0, 3).map(d => {
                const mins = Math.max(0, Math.round((d.departure_time - now) / 60));
                const timeStr = mins === 0 ? "Nu" : `${mins} min`;
                return `<span class="fav-dep">
                    <span class="fav-dep-headsign">${d.headsign}</span>
                    <span class="fav-dep-time">${timeStr}</span>
                </span>`;
            }).join("");
        }).catch(() => {
            const el = document.getElementById(`trip-deps-${safeKey}`);
            if (el) el.innerHTML = `<span class="fav-empty-deps">Fel</span>`;
        });
    });
}

function openFavoritesPanel() {
    renderFavoritesPanel();
    document.getElementById("favorites-panel").classList.add("open");
    clearInterval(favoritesTimer);
    favoritesTimer = setInterval(() => { fetchFavoriteDepartures(); fetchSavedTripDepartures(); }, 15000);
}

function closeFavoritesPanel() {
    document.getElementById("favorites-panel").classList.remove("open");
    clearInterval(favoritesTimer);
    favoritesTimer = null;
}

function showVehiclePopup(vehicle, marker) {
    const color = getRouteColor({
        route_color: vehicle.route_color,
        route_short_name: vehicle.route_short_name,
        route_id: vehicle.route_id,
    });

    const lineName = vehicle.route_short_name || "?";
    let headsign = vehicle.trip_headsign || "";

    // If headsign is a "A - B" route name, show it as-is after "Buss/Tåg X"
    const isTrain = vehicle.vehicle_type === "train";
    const typeLabel = isTrain ? "Tåg" : "Buss";
    const isRouteName = headsign.includes(" - ");
    let title;
    if (headsign && !isRouteName) {
        title = `${typeLabel} ${lineName} mot ${headsign}`;
    } else if (headsign && isRouteName) {
        title = `${typeLabel} ${lineName} ${headsign}`;
    } else {
        title = `${typeLabel} ${lineName}`;
    }

    const speedMs = vehicle.speed != null ? vehicle.speed : vehicle._calculatedSpeed;
    const speed = speedMs != null
        ? `${(speedMs * 3.6).toFixed(0)} km/h`
        : null;
    const status = vehicle.current_status || "I trafik";
    const updatedAt = vehicle.timestamp
        ? new Date(vehicle.timestamp * 1000).toLocaleTimeString("sv-SE")
        : new Date().toLocaleTimeString("sv-SE");

    const nextStop = vehicle.next_stop_name || "";
    const nextStopPlatform = vehicle.next_stop_platform || "";
    const nextStopLabel = vehicle.current_status === "Vid hållplats"
        ? "Vid hållplats"
        : "Nästa hållplats";
    const platformChip = nextStopPlatform
        ? ` <span class="popup-platform">Läge ${nextStopPlatform}</span>`
        : "";

    let delayHtml = "";
    if (!isTrain && vehicle.delay_seconds != null) {
        const delayMin = Math.round(vehicle.delay_seconds / 60);
        if (vehicle.delay_seconds > 60) {
            const nextStopPart = nextStop ? ` till ${nextStop}` : "";
            delayHtml = `<span class="popup-delay popup-delay--late">${delayMin} min försenad${nextStopPart}</span><br/>`;
        } else if (vehicle.delay_seconds < -60) {
            delayHtml = `<span class="popup-delay popup-delay--early">${Math.abs(delayMin)} min tidig</span><br/>`;
        } else {
            delayHtml = `<span class="popup-delay popup-delay--ontime">I tid</span><br/>`;
        }
    }

    const custom = getLineStyle(lineName);
    const badgeBg = custom ? `#${custom.bg}` : (vehicle.route_color ? `#${vehicle.route_color}` : color);
    const badgeFg = custom ? `#${custom.text}` : (vehicle.route_text_color ? `#${vehicle.route_text_color}` : "#fff");
    const vehicleIdStr = vehicle.vehicle_id
        ? `Fordon #${String(vehicle.vehicle_id).split(":").pop()}<br/>`
        : "";
    const hasRoute = vehicle.route_id && routeData[vehicle.route_id];

    const html = `
        <div class="popup-vehicle">
            <div style="margin-bottom:4px">
                <span class="popup-veh-badge" style="background:${badgeBg};color:${badgeFg}">${lineName}</span>
            </div>
            <div class="popup-title" data-color="${color}">${title}</div>
            <div class="popup-details">
                ${delayHtml}
                ${nextStop ? `${nextStopLabel}: <strong>${nextStop}</strong>${platformChip}<br/>` : ""}
                ${speed ? `Hastighet: ${speed}<br/>` : ""}
                ${vehicleIdStr}
                Uppdaterad: ${updatedAt}
            </div>
            ${hasRoute ? `<button class="popup-open-line-btn" data-route-id="${vehicle.route_id}">Visa linje →</button>` : ""}
        </div>
    `;
    const popup = L.popup({ maxWidth: 260 })
        .setLatLng(marker.getLatLng())
        .setContent(html)
        .openOn(map);
    requestAnimationFrame(() => {
        const el = popup.getElement();
        if (!el) return;
        el.querySelectorAll("[data-color]").forEach(e => { e.style.color = e.dataset.color; });
        el.querySelectorAll(".popup-open-line-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                map.closePopup();
                const route = routeData[btn.dataset.routeId];
                if (route) openLinePanel(route);
            });
        });
    });
}

// --- Stops ---
function loadStops() {
    if (stopsLoaded) return;

    const routeIds = Object.keys(routeData);

    fetchStops(routeIds)
        .then((data) => {
            if (data.count === 0) {
                console.log("No stops returned (GTFS static may not be loaded yet)");
                return;
            }

            stopsLayer = L.layerGroup();
            stopMarkerMap = {};

            data.stops.forEach((stop) => {
                const isStation = stop.location_type === 1;
                const icon = L.divIcon({
                    className: "",
                    html: `<div class="${isStation ? 'station-marker' : 'stop-marker'}"></div>`,
                    iconSize: isStation ? [12, 12] : [8, 8],
                    iconAnchor: isStation ? [6, 6] : [4, 4],
                });

                const marker = L.marker([stop.stop_lat, stop.stop_lon], {
                    icon,
                    zIndexOffset: isStation ? 500 : 100,
                });
                marker._stopData = stop;
                marker.bindPopup("", { maxWidth: 320 });
                marker.on("popupopen", () => showStopDepartures(stop, marker));
                stopsLayer.addLayer(marker);
                stopMarkerMap[stop.stop_id] = marker;
            });

            stopsLoaded = true;
            console.log(`Loaded ${data.count} stops`);

            if (showStops) {
                stopsLayer.addTo(map);
                pollStopDepartures();
            }
        })
        .catch((err) => console.error("Error loading stops:", err));
}

// --- Route data ---
function loadRoutes() {
    if (routesLoaded) return;

    fetchRoutes()
        .then((data) => {
            if (data.count === 0) {
                console.log("No routes returned (GTFS static may not be loaded yet)");
                return;
            }

            routeData = {};
            const filtered = ALLOWED_LINE_NUMBERS.size > 0
                ? data.routes.filter(r => ALLOWED_LINE_NUMBERS.has(r.route_short_name))
                : data.routes;
            filtered.forEach((r) => {
                routeData[r.route_id] = r;
            });
            document.getElementById("route-count").textContent = filtered.length;
            buildLineButtons(filtered);
            initTypeFilterButtons();
            routesLoaded = true;
            console.log(`Loaded ${filtered.length} / ${data.count} routes (filtered by config)`);

            // Draw route shapes if enabled by default
            if (showRoutes) toggleRouteShapes(true);

            // Load stops now that we know which route_ids to filter on
            if (!stopsLoaded) {
                loadStops();
            }
        })
        .catch((err) => console.error("Error loading routes:", err));
}


// Load and draw train route shapes (deduplicated per shape_id, always visible).
let trainRailLayer = null;
let trainRoutesLoaded = false;
let trainShapeCoords = []; // raw [[lat,lon]…] arrays — used for bearing snap

function loadTrainRoutes() {
    if (trainRoutesLoaded) return;
    fetchTrainShapes()
        .then(data => {
            if (!data.count) return;
            const layerGroup = L.layerGroup();
            Object.values(data.shapes).forEach(coords => {
                trainShapeCoords.push(coords);
                L.polyline(coords, { color: "#7A3A00", weight: 6, opacity: 0.6 }).addTo(layerGroup);
                L.polyline(coords, { color: "#E87722", weight: 3, opacity: 0.9 }).addTo(layerGroup);
            });
            trainRailLayer = layerGroup;
            layerGroup.addTo(map);
            trainRoutesLoaded = true;
            console.log(`Loaded ${data.count} deduplicated train shapes`);
        })
        .catch(err => console.error("Error loading train routes:", err));
}

// Perpendicular distance (in degrees, good enough for small areas) from point to segment.
function _distToSegment(lat, lon, lat1, lon1, lat2, lon2) {
    const dx = lat2 - lat1, dy = lon2 - lon1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(lat - lat1, lon - lon1);
    const t = Math.max(0, Math.min(1, ((lat - lat1) * dx + (lon - lon1) * dy) / lenSq));
    return Math.hypot(lat - (lat1 + t * dx), lon - (lon1 + t * dy));
}

// True bearing (degrees) from point A to point B.
function _bearingBetween(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Find the bearing of the nearest rail segment to (lat, lon).
function snapBearingToTrack(lat, lon) {
    let minDist = Infinity, snapBearing = null;
    for (const coords of trainShapeCoords) {
        for (let i = 0; i < coords.length - 1; i++) {
            const [lat1, lon1] = coords[i], [lat2, lon2] = coords[i + 1];
            const d = _distToSegment(lat, lon, lat1, lon1, lat2, lon2);
            if (d < minDist) {
                minDist = d;
                snapBearing = _bearingBetween(lat1, lon1, lat2, lon2);
            }
        }
    }
    return snapBearing;
}


function loadRouteShapes(routeId) {
    if (routeLayers[routeId]) {
        if (showRoutes && !map.hasLayer(routeLayers[routeId])) {
            routeLayers[routeId].addTo(map);
        }
        return Promise.resolve();
    }

    return fetchShapeForRoute(routeId)
        .then((data) => {
            const route = routeData[routeId] || {};
            const color = getRouteColor(route);
            const layerGroup = L.layerGroup();

            Object.values(data.shapes).forEach((coords) => {
                const polyline = L.polyline(coords, {
                    color: color,
                    weight: 3,
                    opacity: 0.7,
                });
                layerGroup.addLayer(polyline);
            });

            routeLayers[routeId] = layerGroup;
            if (showRoutes) {
                layerGroup.addTo(map);
            }
        })
        .catch((err) => console.error(`Error loading shapes for ${routeId}:`, err));
}

async function toggleRouteShapes(visible) {
    if (!visible) {
        Object.values(routeLayers).forEach((layer) => map.removeLayer(layer));
        return;
    }

    const routeIds = activeFilters.size > 0
        ? [...activeFilters]
        : Object.keys(routeData);

    // Show already-cached layers immediately; collect which still need fetching
    const toFetch = routeIds.filter((rid) => {
        if (routeLayers[rid]) {
            if (showRoutes && !map.hasLayer(routeLayers[rid])) routeLayers[rid].addTo(map);
            return false;
        }
        return true;
    });

    if (toFetch.length === 0) return;

    if (toFetch.length === 1) {
        // Single route — use per-route endpoint (e.g. from a filter button click)
        loadRouteShapes(toFetch[0]);
        return;
    }

    // Bulk fetch — one request instead of N parallel requests
    try {
        const data = await fetchShapesBulk(toFetch);

        Object.entries(data.routes).forEach(([routeId, shapeCoordsList]) => {
            const route = routeData[routeId] || {};
            const color = getRouteColor(route);
            const layerGroup = L.layerGroup();
            shapeCoordsList.forEach((coords) => {
                L.polyline(coords, { color, weight: 3, opacity: 0.7 }).addTo(layerGroup);
            });
            routeLayers[routeId] = layerGroup;
            if (showRoutes) layerGroup.addTo(map);
        });
    } catch (err) {
        console.error("Error loading shapes (bulk):", err);
    }
}

// --- Line filter buttons ---
function buildLineButtons(routes) {
    const container = document.getElementById("line-buttons");
    container.innerHTML = "";

    const sorted = [...routes].sort((a, b) => {
        const na = parseInt(a.route_short_name);
        const nb = parseInt(b.route_short_name);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return (a.route_short_name || "").localeCompare(b.route_short_name || "");
    });

    sorted.forEach((route) => {
        const color = getRouteColor(route);
        const textColor = getRouteTextColor(route);

        const btn = document.createElement("button");
        btn.className = "line-btn";
        btn.style.background = color;
        btn.style.color = textColor;
        btn.textContent = route.route_short_name || route.route_id;
        btn.title = route.route_long_name || route.route_short_name;

        btn.addEventListener("click", () => {
            if (activeFilters.has(route.route_id)) {
                activeFilters.delete(route.route_id);
                btn.classList.remove("inactive");
            } else if (activeFilters.size === 0) {
                activeFilters.clear();
                activeFilters.add(route.route_id);
                document.querySelectorAll(".line-btn").forEach((b) =>
                    b.classList.add("inactive")
                );
                btn.classList.remove("inactive");
            } else {
                activeFilters.add(route.route_id);
                btn.classList.remove("inactive");
            }

            if (activeFilters.size >= sorted.length) {
                activeFilters.clear();
                document.querySelectorAll(".line-btn").forEach((b) =>
                    b.classList.remove("inactive")
                );
            }

            if (showRoutes) {
                Object.values(routeLayers).forEach((l) => map.removeLayer(l));
                toggleRouteShapes(true);
            }

            if (activePanelRouteId === route.route_id) {
                closeLinePanel();
            } else {
                openLinePanel(route);
            }
        });

        container.appendChild(btn);
    });
}

// --- Vehicle type filter buttons ---
function initTypeFilterButtons() {
    const types = [
        { type: "bus",   label: "Bussar" },
        { type: "train", label: "Tåg" },
    ];
    types.forEach(({ type, label }) => {
        const btn = document.getElementById(`type-btn-${type}`);
        if (!btn) return;
        btn.addEventListener("click", () => {
            if (hiddenTypes.has(type)) {
                hiddenTypes.delete(type);
                btn.classList.remove("inactive");
            } else {
                hiddenTypes.add(type);
                btn.classList.add("inactive");
            }
        });
    });

    const dashBtn = document.getElementById("dashboard-btn");
    if (dashBtn) dashBtn.addEventListener("click", openDashboardPanel);
    const dashClose = document.getElementById("dashboard-panel-close");
    if (dashClose) dashClose.addEventListener("click", closeDashboardPanel);
}

// --- Line departure panel ---
function openLinePanel(route) {
    activePanelRouteId = route.route_id;

    const color = getRouteColor(route);
    const textColor = getRouteTextColor(route);
    const titleEl = document.getElementById("line-panel-title");
    titleEl.innerHTML =
        `<span class="dep-badge" data-bg="${color}" data-fg="${textColor}">${route.route_short_name}</span>` +
        `<span class="lp-route-name">${route.route_long_name || ""}</span>`;
    applyBadgeColors(titleEl);
    document.getElementById("line-panel-content").innerHTML =
        `<div class="lp-loading">Hämtar avgångar…</div>`;
    document.getElementById("line-panel").classList.add("open");
    document.body.classList.add("panel-open");

    // Highlight active button
    document.querySelectorAll(".line-btn").forEach(b => b.classList.remove("panel-active"));
    document.querySelectorAll(".line-btn").forEach(b => {
        if (b.textContent.trim() === (route.route_short_name || route.route_id)) {
            b.classList.add("panel-active");
        }
    });

    map.invalidateSize();
    fetchLineDepartures(route.route_id);

    clearInterval(linePanelTimer);
    linePanelTimer = setInterval(() => {
        if (activePanelRouteId) fetchLineDepartures(activePanelRouteId);
    }, 30000);
}

function closeLinePanel() {
    activePanelRouteId = null;
    activeFilters.clear();
    document.getElementById("line-panel").classList.remove("open");
    document.body.classList.remove("panel-open");
    document.querySelectorAll(".line-btn").forEach(b => {
        b.classList.remove("panel-active");
        b.classList.remove("inactive");
    });
    clearInterval(linePanelTimer);
    map.invalidateSize();
    setTimeout(() => map.invalidateSize(), 310);
}

function fetchLineDepartures(routeId) {
    apiFetchLineDepartures(routeId)
        .then(data => {
            if (activePanelRouteId !== routeId) return;
            const content = document.getElementById("line-panel-content");
            if (!data.directions || data.directions.length === 0) {
                content.innerHTML = `<div class="lp-empty">Inga kommande avgångar</div>`;
                return;
            }

            const now = Date.now() / 1000;
            content.innerHTML = data.directions.map(dir => {
                const rows = (dir.stops || []).map(s => {
                    const dt = new Date(s.time * 1000);
                    const clock = dt.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
                    const min = Math.max(0, Math.round((s.time - now) / 60));
                    const minStr = min === 0 ? "Nu" : `${min} min`;
                    const minClass = min <= 2 ? "lp-min soon" : "lp-min";
                    const rt = s.is_realtime ? `<span class="lp-rt">RT</span>` : "";
                    return `<div class="lp-dep">
                        <span class="lp-stop">${s.stop_name}</span>
                        <span class="lp-time">${clock}</span>
                        <span class="${minClass}">${minStr}</span>
                        ${rt}
                    </div>`;
                }).join("");
                return `<div class="lp-section">
                    <div class="lp-section-header">mot ${dir.headsign}</div>
                    ${rows}
                </div>`;
            }).join("");
        })
        .catch(() => {
            if (activePanelRouteId !== routeId) return;
            document.getElementById("line-panel-content").innerHTML =
                `<div class="lp-empty">Kunde inte hämta avgångar</div>`;
        });
}

// --- Dashboard panel ---
let _dashAlerts = [];

function updateDashboard(vehicles) {
    const buses = vehicles.filter(v => v.vehicle_type !== "train").length;
    const trains = vehicles.filter(v => v.vehicle_type === "train").length;
    const routes = new Set(vehicles.map(v => v.route_id).filter(Boolean)).size;
    const elB = document.getElementById("dash-buses");
    const elT = document.getElementById("dash-trains");
    const elR = document.getElementById("dash-routes");
    if (elB) elB.textContent = buses;
    if (elT) elT.textContent = trains;
    if (elR) elR.textContent = routes;
}

function updateDashboardAlerts(alerts) {
    _dashAlerts = alerts;
    const el = document.getElementById("dash-alerts");
    const card = document.getElementById("dash-alerts-card");
    const list = document.getElementById("dash-alerts-list");
    if (el) el.textContent = alerts.length;
    if (card) card.classList.toggle("has-alerts", alerts.length > 0);
    if (list) {
        list.innerHTML = alerts.length === 0
            ? `<div class="dash-no-alerts">Inga aktiva störningar</div>`
            : alerts.map(a => `<div class="dash-alert-item">
                <span class="dash-alert-icon">⚠</span>
                <div><strong>${a.header}</strong>${a.description ? `<br><span class="dash-alert-desc">${a.description}</span>` : ""}</div>
              </div>`).join("");
    }
}

function renderDashboardFavorites() {
    const section = document.getElementById("dash-favorites-body");
    if (!section) return;
    if (favoriteStops.size === 0) {
        section.innerHTML = `<div class="dash-no-fav">Inga favorithållplatser. Klicka ★ i en hållplats-popup.</div>`;
        return;
    }
    section.innerHTML = [...favoriteStops.values()].map(s => `
        <div class="dash-fav-stop" data-stop-id="${s.stop_id}">
            <span class="dash-fav-name">${s.stop_name}</span>
            <div class="dash-fav-deps" id="dashdeps-${s.stop_id}"><span class="fav-loading">Hämtar…</span></div>
        </div>`).join("");
    favoriteStops.forEach(s => {
        fetchDepartures(s.stop_id, 3).then(data => {
            const el = document.getElementById(`dashdeps-${s.stop_id}`);
            if (!el) return;
            if (!data.departures || data.departures.length === 0) {
                el.innerHTML = `<span class="fav-empty-deps">Inga avgångar</span>`;
                return;
            }
            const now = Date.now() / 1000;
            el.innerHTML = data.departures.map(d => {
                const mins = Math.max(0, Math.round((d.departure_time - now) / 60));
                const timeStr = mins === 0 ? "Nu" : `${mins} min`;
                const custom = getLineStyle(d.route_short_name);
                const bg = custom ? `#${custom.bg}` : `#${d.route_color}`;
                const fg = custom ? `#${custom.text}` : `#${d.route_text_color}`;
                return `<span class="fav-dep">
                    <span class="fav-dep-badge" style="background:${bg};color:${fg}">${d.route_short_name}</span>
                    <span class="fav-dep-headsign">${d.headsign}</span>
                    <span class="fav-dep-time">${timeStr}</span>
                </span>`;
            }).join("");
        });
    });
}

// --- Delays overlay ---
function buildDelaysTable() {
    const buses = Object.values(vehicleMarkers)
        .map(m => m._vehicleData)
        .filter(v => v && v.vehicle_type !== "train" && v.delay_seconds != null && v.delay_seconds > 60);

    buses.sort((a, b) => b.delay_seconds - a.delay_seconds);
    const top = buses.slice(0, 20);

    const tbody = document.getElementById("delays-tbody");
    const empty = document.getElementById("delays-empty");
    const table = document.getElementById("delays-table");

    if (top.length === 0) {
        table.style.display = "none";
        empty.style.display = "";
        return;
    }
    table.style.display = "";
    empty.style.display = "none";

    tbody.innerHTML = top.map(v => {
        const delayMin = Math.round(v.delay_seconds / 60);
        const delayClass = v.delay_seconds > 300 ? "delays-delay--critical" : "delays-delay--warning";
        const color = getRouteColor({
            route_color: v.route_color,
            route_short_name: v.route_short_name,
            route_id: v.route_id,
        });
        const textColor = getRouteTextColor(v);
        const line = v.route_short_name || "?";
        const dest = v.trip_headsign || "—";
        const stop = v.next_stop_name || "—";
        return `<tr data-vehicle-id="${v.vehicle_id || v.id}">
            <td><span class="delays-line-chip" style="background:#${v.route_color||'0074D9'};color:#${v.route_text_color||'FFFFFF'}">${line}</span></td>
            <td>${dest}</td>
            <td class="delays-delay-cell ${delayClass}">+${delayMin} min</td>
            <td>${stop}</td>
        </tr>`;
    }).join("");

    // Click row → close overlay and pan to vehicle
    tbody.querySelectorAll("tr[data-vehicle-id]").forEach(row => {
        row.addEventListener("click", () => {
            const vid = row.dataset.vehicleId;
            closeDelaysPanel();
            const marker = vehicleMarkers[vid];
            if (marker) {
                map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
                marker.fire("click");
            }
        });
    });
}

function openDelaysPanel() {
    buildDelaysTable();
    document.getElementById("delays-overlay").classList.add("open");
}
function closeDelaysPanel() {
    document.getElementById("delays-overlay").classList.remove("open");
}
function initDelaysPanel() {
    document.getElementById("delays-btn").addEventListener("click", openDelaysPanel);
    document.getElementById("delays-panel-close").addEventListener("click", closeDelaysPanel);
    document.getElementById("delays-overlay").addEventListener("click", e => {
        if (e.target === document.getElementById("delays-overlay")) closeDelaysPanel();
    });
}

// --- Traffic inference layer ---
let trafficLayer = null;
let showTraffic = false;
let _trafficTimer = null;
let zoneLayer = null;
let showZones = false;

const TRAFFIC_COLORS = { none: "#888", low: "#FFD600", medium: "#FF9800", high: "#F44336" };

async function pollTraffic() {
    if (!showTraffic) return;
    try {
        const resp = await fetch("/api/traffic?min_confidence=0.3&min_severity=low");
        if (!resp.ok) return;
        const data = await resp.json();
        renderTrafficLayer(data);
    } catch (_) {}
}

function renderTrafficLayer(geojson) {
    if (!trafficLayer) trafficLayer = L.layerGroup().addTo(map);
    trafficLayer.clearLayers();

    for (const f of (geojson.features || [])) {
        const p = f.properties;
        const coords = f.geometry.coordinates.map(c => [c[1], c[0]]);
        if (coords.length < 2) continue;

        const color = TRAFFIC_COLORS[p.severity] || "#888";
        const opacity = Math.max(0.35, Math.min(1, p.confidence || 0.5));

        L.polyline(coords, {
            color,
            weight: 7,
            opacity,
            lineCap: "round",
            lineJoin: "round",
        }).bindTooltip(
            `<b>Hastighet:</b> ${p.current_speed_kmh != null ? p.current_speed_kmh.toFixed(0) : "?"} km/h` +
            (p.expected_speed_kmh ? ` (normalt ${p.expected_speed_kmh.toFixed(0)})` : "") +
            `<br><b>Fordon:</b> ${p.affected_vehicles}` +
            `<br><b>Linjer:</b> ${p.unique_routes}` +
            `<br><b>Konfidens:</b> ${(p.confidence * 100).toFixed(0)}%`,
            { sticky: true }
        ).addTo(trafficLayer);
    }
}

async function fetchZones() {
    try {
        const resp = await fetch("/api/traffic/zones");
        if (!resp.ok) return;
        renderZoneLayer(await resp.json());
    } catch (_) {}
}

function renderZoneLayer(data) {
    if (!zoneLayer) zoneLayer = L.layerGroup().addTo(map);
    zoneLayer.clearLayers();

    for (const t of (data.terminal || [])) {
        L.circle([t.lat, t.lon], {
            radius: 60,
            color: "#a855f7",
            fillColor: "#a855f7",
            fillOpacity: 0.15,
            weight: 1.5,
            opacity: 0.7,
        }).bindTooltip("Ändhållplats", { sticky: true }).addTo(zoneLayer);
    }

    for (const s of (data.signal || [])) {
        L.circle([s.lat, s.lon], {
            radius: s.radius_m || 30,
            color: "#f97316",
            fillColor: "#f97316",
            fillOpacity: 0.15,
            weight: 1.5,
            opacity: 0.7,
        }).bindTooltip("Trafiksignal", { sticky: true }).addTo(zoneLayer);
    }
}

function initTrafficLayer() {
    document.getElementById("traffic-btn").addEventListener("click", () => {
        showTraffic = !showTraffic;
        document.getElementById("traffic-btn").classList.toggle("active", showTraffic);
        document.getElementById("traffic-legend").classList.toggle("visible", showTraffic);
        if (showTraffic) {
            pollTraffic();
            _trafficTimer = setInterval(pollTraffic, 30000);
        } else {
            clearInterval(_trafficTimer);
            if (trafficLayer) trafficLayer.clearLayers();
            // Also hide zones when traffic is turned off
            if (showZones) {
                showZones = false;
                document.getElementById("zone-overlay-btn").classList.remove("active");
                document.getElementById("zone-legend-rows").classList.remove("visible");
                if (zoneLayer) zoneLayer.clearLayers();
            }
        }
    });

    document.getElementById("zone-overlay-btn").addEventListener("click", () => {
        showZones = !showZones;
        document.getElementById("zone-overlay-btn").classList.toggle("active", showZones);
        document.getElementById("zone-legend-rows").classList.toggle("visible", showZones);
        if (showZones) {
            fetchZones();
        } else {
            if (zoneLayer) zoneLayer.clearLayers();
        }
    });
}

function openDashboardPanel() {
    updateDashboardAlerts(_dashAlerts);
    renderDashboardFavorites();
    document.getElementById("dashboard-panel").classList.add("open");
}
function closeDashboardPanel() {
    document.getElementById("dashboard-panel").classList.remove("open");
}

// --- Alerts ---
function filterAlertsForDisplayedLines(alerts) {
    if (ALLOWED_LINE_NUMBERS.size === 0) return alerts;
    return alerts.filter(a => {
        if (!a.affected_routes || a.affected_routes.length === 0) return false;
        return a.affected_routes.some(routeId => {
            const route = routeData[routeId];
            return route && ALLOWED_LINE_NUMBERS.has(route.route_short_name);
        });
    });
}

function updateAlerts(alerts) {
    const filtered = filterAlertsForDisplayedLines(alerts);
    updateDashboardAlerts(filtered);
}

// --- Status banner ---
function showStatusBanner(message) {
    let banner = document.getElementById("status-banner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "status-banner";
        document.body.appendChild(banner);
    }
    banner.textContent = message;
    banner.style.display = "block";
}

function hideStatusBanner() {
    const banner = document.getElementById("status-banner");
    if (banner) {
        banner.style.display = "none";
    }
}

// --- Check backend status and retry loading data ---
async function checkStatus() {
    try {
        const data = await fetchStatus();

        if (data.nearby_radius_meters) nearbyRadius = data.nearby_radius_meters;
        if (data.frontend_poll_interval_ms) POLL_INTERVAL = data.frontend_poll_interval_ms;

        if (data.gtfs_error) {
            showStatusBanner("GTFS-data kunde inte laddas. Kontrollera serverloggen.");
            return;
        }

        if (data.routes_count === 0) {
            showStatusBanner("Laddar GTFS-data (linjer, h\u00e5llplatser)...");
            return;
        }

        // GTFS loaded — load stops/routes if not done yet
        hideStatusBanner();

        if (!routesLoaded) {
            loadRoutes();
        }
        if (!trainRoutesLoaded) {
            loadTrainRoutes();
        }
    } catch (err) {
        console.error("Error checking status:", err);
    }
}

// --- Polling ---
async function pollVehicles() {
    try {
        const data = await fetchVehicles();
        updateVehicles(data.vehicles);
    } catch (err) {
        console.error("Error polling vehicles:", err);
    }
}

async function pollAlerts() {
    try {
        const data = await fetchAlerts();
        updateAlerts(data.alerts);
    } catch (err) {
        console.error("Error polling alerts:", err);
    }
}

async function pollStopDepartures() {
    if (!stopsLoaded || !showStops) return;
    try {
        const data = await fetchNextDepartures();
        stopNextDep = data;
        updateStopBadges();
    } catch (err) {
        console.error("Error polling stop departures:", err);
    }
}

function updateStopBadges() {
    if (!stopsLoaded) return;
    const zoom = map ? map.getZoom() : 0;
    const showBadges = showStops && zoom >= BADGE_MIN_ZOOM;

    Object.entries(stopMarkerMap).forEach(([stopId, marker]) => {
        const stop = marker._stopData;
        if (!stop) return;
        const isStation = stop.location_type === 1;
        const dep = stopNextDep[stopId];

        let iconEl, iconSize, iconAnchor;
        if (dep && showBadges) {
            const min   = dep.minutes;
            const label = min === 0 ? "Nu" : `${min}m`;
            const bg    = dep.route_color    || "0074D9";
            const fg    = dep.route_text_color || "FFFFFF";

            // Build badge with DOM API — avoids inline style= HTML attributes
            const wrap = document.createElement("div");
            wrap.className = "stop-badge-wrap";  // see style.css
            const dot = document.createElement("div");
            dot.className = isStation ? "station-marker" : "stop-marker";
            const pill = document.createElement("span");
            pill.className = "stop-badge-pill";
            const lineSpan = document.createElement("span");
            lineSpan.className   = "sbp-line";
            lineSpan.textContent = dep.route_short_name;
            lineSpan.style.background = `#${bg}`;
            lineSpan.style.color      = `#${fg}`;
            const timeSpan = document.createElement("span");
            timeSpan.className   = "sbp-time";
            timeSpan.textContent = label;
            pill.appendChild(lineSpan);
            pill.appendChild(timeSpan);
            if (stop.platform_code) {
                const plat = document.createElement("span");
                plat.className   = "sbp-platform";
                plat.textContent = stop.platform_code;
                pill.appendChild(plat);
            }
            wrap.appendChild(dot);
            wrap.appendChild(pill);
            iconEl = wrap;
            const extraWidth = stop.platform_code ? 14 : 0;
            iconSize   = isStation ? [80 + extraWidth, 14] : [72 + extraWidth, 10];
            iconAnchor = isStation ? [6, 7] : [4, 5];
        } else {
            const dot = document.createElement("div");
            dot.className = isStation ? "station-marker" : "stop-marker";
            iconEl     = dot;
            iconSize   = isStation ? [12, 12] : [8, 8];
            iconAnchor = isStation ? [6, 6] : [4, 4];
        }

        marker.setIcon(L.divIcon({ className: "", html: iconEl, iconSize, iconAnchor }));
    });
}

// --- Favorites panel ---
function initFavoritesPanel() {
    const btn = document.getElementById("fav-panel-btn");
    if (btn) btn.addEventListener("click", openFavoritesPanel);
    const closeBtn = document.getElementById("favorites-panel-close");
    if (closeBtn) closeBtn.addEventListener("click", closeFavoritesPanel);
}

// --- GPS / Nearby panel ---
function initGps() {
    document.getElementById("gps-btn").addEventListener("click", toggleGps);
    document.getElementById("nearby-panel-close").addEventListener("click", closeNearbyPanel);
}

function toggleGps() {
    if (nearbyPanelOpen) {
        closeNearbyPanel();
        return;
    }
    if (!navigator.geolocation) {
        alert("Din enhet stödjer inte GPS-positionering.");
        return;
    }
    const btn = document.getElementById("gps-btn");
    btn.classList.add("locating");
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            btn.classList.remove("locating");
            btn.classList.add("active");
            onPosition(pos);
            openNearbyPanel();
            // Watch for position updates
            if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
            geoWatchId = navigator.geolocation.watchPosition(onPosition, null, {
                enableHighAccuracy: true, maximumAge: 10000,
            });
        },
        () => {
            btn.classList.remove("locating");
            alert("Kunde inte hämta din position. Kontrollera att platsåtkomst är tillåten.");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function onPosition(pos) {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;

    // Update or create user marker
    const latlng = [lat, lon];
    if (!userMarker) {
        userMarker = L.marker(latlng, {
            icon: L.divIcon({
                className: "",
                html: `<div class="user-location-dot"><div class="user-location-pulse"></div></div>`,
                iconSize: [16, 16],
                iconAnchor: [8, 8],
            }),
            zIndexOffset: 2000,
        }).addTo(map);
    } else {
        userMarker.setLatLng(latlng);
    }

    if (!userAccCircle) {
        userAccCircle = L.circle(latlng, {
            radius: accuracy,
            color: "#3b82f6",
            fillColor: "#3b82f6",
            fillOpacity: 0.08,
            weight: 1,
            opacity: 0.4,
        }).addTo(map);
    } else {
        userAccCircle.setLatLng(latlng).setRadius(accuracy);
    }

    // Only zoom on first fix
    if (!lastNearbyPos) {
        map.setView(latlng, 16);
    }

    // Refresh nearby if moved > 30m
    const moved = lastNearbyPos
        ? map.distance(lastNearbyPos, latlng)
        : Infinity;
    lastNearbyPos = latlng;
    if (moved > 30 && nearbyPanelOpen) {
        fetchNearbyDepartures(lat, lon);
    }
}

function openNearbyPanel() {
    nearbyPanelOpen = true;
    document.getElementById("nearby-panel").classList.add("open");
    document.body.classList.add("nearby-open");
    map.invalidateSize();
    setTimeout(() => {
        map.invalidateSize();
        if (lastNearbyPos) map.panTo(lastNearbyPos);
    }, 320);
    if (lastNearbyPos) {
        fetchNearbyDepartures(lastNearbyPos[0], lastNearbyPos[1]);
    }
    clearInterval(nearbyTimer);
    nearbyTimer = setInterval(() => {
        if (nearbyPanelOpen && lastNearbyPos) {
            fetchNearbyDepartures(lastNearbyPos[0], lastNearbyPos[1]);
        }
    }, 30000);
}

function closeNearbyPanel() {
    nearbyPanelOpen = false;
    document.getElementById("nearby-panel").classList.remove("open");
    document.body.classList.remove("nearby-open");
    document.getElementById("gps-btn").classList.remove("active");
    clearInterval(nearbyTimer);
    if (geoWatchId !== null) {
        navigator.geolocation.clearWatch(geoWatchId);
        geoWatchId = null;
    }
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    if (userAccCircle) { map.removeLayer(userAccCircle); userAccCircle = null; }
    lastNearbyPos = null;
    map.invalidateSize();
}

function fetchNearbyDepartures(lat, lon) {
    const body = document.getElementById("nearby-panel-body");
    if (!body.hasChildNodes()) {
        body.innerHTML = `<div class="nearby-loading">Söker hållplatser…</div>`;
    }
    apiFetchNearbyDepartures(lat, lon, nearbyRadius)
        .then(data => {
            if (!nearbyPanelOpen) return;
            if (!data.stops || data.stops.length === 0) {
                body.innerHTML = `<div class="nearby-empty">Inga hållplatser inom ${nearbyRadius} m</div>`;
                return;
            }
            const now = Date.now() / 1000;
            body.innerHTML = data.stops.map(stop => {
                const distStr = stop.distance_m < 1000
                    ? `${stop.distance_m} m`
                    : `${(stop.distance_m / 1000).toFixed(1)} km`;
                const deps = stop.departures.map(d => {
                    const custom = getLineStyle(d.route_short_name);
                    const bg = custom ? `#${custom.bg}` : `#${d.route_color}`;
                    const fg = custom ? `#${custom.text}` : `#${d.route_text_color}`;
                    const min = Math.max(0, Math.round((d.departure_time - now) / 60));
                    const minStr = min === 0 ? "Nu" : `${min} min`;
                    const minClass = min <= 2 ? "nearby-min soon" : "nearby-min";
                    const rt = d.is_realtime ? `<span class="lp-rt">RT</span>` : "";
                    return `<div class="nearby-dep">
                        <span class="dep-badge" data-bg="${bg}" data-fg="${fg}">${d.route_short_name}</span>
                        <span class="nearby-headsign">${d.headsign}</span>
                        <span class="${minClass}">${minStr}</span>
                        ${rt}
                    </div>`;
                }).join("") || `<div class="nearby-nodep">Inga avgångar</div>`;
                const platformLabel = stop.platform_code
                    ? `<span class="nearby-platform">Läge ${stop.platform_code}</span>`
                    : stop.stop_desc
                        ? `<span class="nearby-platform">${stop.stop_desc}</span>`
                        : "";
                return `<div class="nearby-stop">
                    <div class="nearby-stop-header">
                        <span class="nearby-stop-name">${stop.stop_name}${platformLabel}</span>
                        <span class="nearby-dist">${distStr}</span>
                    </div>
                    ${deps}
                </div>`;
            }).join("");
            applyBadgeColors(body);
        })
        .catch(() => {
            if (!nearbyPanelOpen) return;
            document.getElementById("nearby-panel-body").innerHTML =
                `<div class="nearby-empty">Kunde inte hämta avgångar</div>`;
        });
}

// --- Controls ---
function initControls() {
    document.getElementById("toggle-stops").addEventListener("change", (e) => {
        showStops = e.target.checked;
        if (showStops) {
            if (!stopsLoaded) {
                loadStops();
            } else if (stopsLayer) {
                stopsLayer.addTo(map);
                pollStopDepartures();
            }
        } else if (stopsLayer) {
            map.removeLayer(stopsLayer);
            updateStopBadges(); // clears badges
        }
    });

    document.getElementById("toggle-routes").addEventListener("change", (e) => {
        showRoutes = e.target.checked;
        if (showRoutes && !routesLoaded) {
            loadRoutes();
        }
        toggleRouteShapes(showRoutes);
    });

    document.getElementById("toggle-labels").addEventListener("change", (e) => {
        showLabels = e.target.checked;
        Object.values(vehicleMarkers).forEach((marker) => {
            if (marker._vehicleData) {
                marker.setIcon(createBusIcon(marker._vehicleData));
            }
        });
    });

document.getElementById("toggle-darkmode").addEventListener("change", (e) => {
        darkMode = e.target.checked;
        localStorage.setItem("darkMode", darkMode);
        setTileLayer(darkMode);
        document.body.classList.toggle("light-mode", !darkMode);
    });

    // Line panel close
    document.getElementById("line-panel-close").addEventListener("click", closeLinePanel);

    // Stop panel close (mobile)
    document.getElementById("stop-panel-close").addEventListener("click", closeStopPanel);

    // Hamburger (mobile: toggles controls dropdown)
    document.getElementById("hamburger-btn").addEventListener("click", () => {
        const ctrl = document.getElementById("topbar-controls");
        const btn = document.getElementById("hamburger-btn");
        const open = ctrl.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
    });


}

// Delta-SSE state: accumulated vehicle map, used to merge incremental updates.
let _vehicleState = new Map();    // vehicle_id -> vehicle object
let _deltaReady   = false;         // true after first full vehicles sync

function initSSE() {
    if (sseSource) {
        sseSource.close();
        sseSource = null;
    }
    _deltaReady = false;

    function cancelFallback() {
        if (sseFallbackTimer) { clearInterval(sseFallbackTimer); sseFallbackTimer = null; }
    }

    sseSource = connectSSE(
        // onVehicles — full list; used for initial sync and reconnect resets
        (data) => {
            cancelFallback();
            _vehicleState.clear();
            (data.vehicles || []).forEach(v => { if (v.vehicle_id) _vehicleState.set(v.vehicle_id, v); });
            updateVehicles(data.vehicles);
            _deltaReady = true;
        },
        // onAlerts
        (data) => updateAlerts(data.alerts),
        // onError
        () => {
            if (!sseFallbackTimer) {
                console.warn("SSE unavailable, falling back to polling");
                sseFallbackTimer = setInterval(pollVehicles, POLL_INTERVAL);
            }
        },
        // onOpen — (re)connected; reset delta so next vehicles event re-syncs
        () => {
            cancelFallback();
            _deltaReady = false;
        },
        // onVehiclesDelta — incremental update (fires only when something changed)
        (data) => {
            if (!_deltaReady) return;  // wait for initial full sync
            cancelFallback();
            (data.updated || []).forEach(v => { if (v.vehicle_id) _vehicleState.set(v.vehicle_id, v); });
            (data.removed || []).forEach(id => _vehicleState.delete(id));
            updateVehicles(Array.from(_vehicleState.values()));
        },
        // onTraffic — traffic inference GeoJSON pushed from backend after each RT poll
        (data) => {
            if (showTraffic) renderTrafficLayer(data);
        },
    );
}

// --- Init ---
async function init() {
    // Fetch backend config before initMap so map center/zoom come from .env, not hardcodes.
    try {
        const cfg = await fetchStatus();
        if (cfg.map_center_lat && cfg.map_center_lon) {
            MAP_CENTER = [cfg.map_center_lat, cfg.map_center_lon];
        }
        if (cfg.map_default_zoom) MAP_ZOOM = cfg.map_default_zoom;
        if (cfg.nearby_radius_meters) nearbyRadius = cfg.nearby_radius_meters;
        if (cfg.frontend_poll_interval_ms) POLL_INTERVAL = cfg.frontend_poll_interval_ms;
    } catch (_) { /* use built-in defaults */ }

    initMap();
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.has("debug")) {
        addDriftsplatsOverlay();
    }

    // ?lat=&lon=&zoom= — fly to specific location (e.g. from traffic segment links)
    const urlLat  = parseFloat(urlParams.get("lat"));
    const urlLon  = parseFloat(urlParams.get("lon"));
    const urlZoom = parseInt(urlParams.get("zoom"), 10);
    if (!isNaN(urlLat) && !isNaN(urlLon)) {
        map.setView([urlLat, urlLon], !isNaN(urlZoom) ? urlZoom : 17);
    }
    initControls();
    initGps();
    initFavoritesPanel();
    initDelaysPanel();
    initTrafficLayer();

    // Check status — loads stops/routes when GTFS is ready
    await checkStatus();

    await pollVehicles();
    await pollAlerts();

    // Real-time updates via SSE (automatic fallback to polling on error)
    initSSE();
    setInterval(pollAlerts, 30000);
    setInterval(pollStopDepartures, 60000);

    updateWeather();
    setInterval(updateWeather, 10 * 60 * 1000);

    // ?line=<route_short_name> — pre-open line filter (e.g. from busboard.html "Se på karta" link)
    const preOpenLine = urlParams.get("line");
    if (preOpenLine) {
        // Wait until routes are loaded, then trigger the matching line button
        const tryOpenLine = setInterval(() => {
            if (!routesLoaded) return;
            clearInterval(tryOpenLine);
            const route = Object.values(routeData).find(
                r => r.route_short_name === preOpenLine || r.route_id === preOpenLine
            );
            if (route) openLinePanel(route);
        }, 500);
    }

    // Keep checking if GTFS data has loaded (retry every 10s until loaded)
    const statusInterval = setInterval(async () => {
        await checkStatus();
        if (routesLoaded && stopsLoaded) {
            clearInterval(statusInterval);
        }
    }, 10000);
}

document.addEventListener("DOMContentLoaded", init);
