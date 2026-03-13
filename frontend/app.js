/**
 * LTlive - Live bus tracking for Örebro
 * Leaflet map with GTFS-RT vehicle positions
 */

const API_BASE = "/api";
const POLL_INTERVAL = 5000; // 5 seconds
const OREBRO_CENTER = [59.2753, 15.2134];
const DEFAULT_ZOOM = 13;

// --- State ---
let map;
let vehicleMarkers = {};    // keyed by vehicle_id
let stopMarkers = [];
let routeLayers = {};        // keyed by route_id
let routeData = {};          // route info keyed by route_id
let activeFilters = new Set(); // route_ids to show (empty = show all)
let showStops = false;
let showRoutes = false;
let showLabels = true;
let stopsLayer = null;
let shapesLoaded = false;

// --- Default line colors (fallback if GTFS has no color) ---
const LINE_COLORS = [
    "E63946", "457B9D", "2A9D8F", "E9C46A", "F4A261",
    "264653", "6A0572", "AB83A1", "118AB2", "073B4C",
    "D62828", "F77F00", "FCBF49", "2EC4B6", "011627",
    "FF6B6B", "4ECDC4", "45B7D1", "96CEB4", "FFEAA7",
];

function getRouteColor(route) {
    if (route.route_color && route.route_color !== "000000") {
        return `#${route.route_color}`;
    }
    // Generate deterministic color from route name
    const name = route.route_short_name || route.route_id;
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return `#${LINE_COLORS[Math.abs(hash) % LINE_COLORS.length]}`;
}

// --- Map Init ---
function initMap() {
    map = L.map("map", {
        center: OREBRO_CENTER,
        zoom: DEFAULT_ZOOM,
        zoomControl: true,
    });

    // CartoDB dark matter basemap
    L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | Data: <a href="https://trafiklab.se">Trafiklab</a>',
            subdomains: "abcd",
            maxZoom: 19,
        }
    ).addTo(map);
}

// --- Bus markers ---
function createBusIcon(vehicle) {
    const color = getRouteColor({
        route_color: vehicle.route_color,
        route_short_name: vehicle.route_short_name,
        route_id: vehicle.route_id,
    });
    const textColor = vehicle.route_text_color
        ? `#${vehicle.route_text_color}`
        : "#fff";
    const label = vehicle.route_short_name || "";
    const size = showLabels && label ? Math.max(24, label.length * 8 + 12) : 14;
    const height = showLabels && label ? 24 : 14;

    return L.divIcon({
        className: "",
        html: `<div class="bus-marker ${!showLabels || !label ? 'no-label' : ''}"
                    style="background:${color}; color:${textColor}; width:${size}px; height:${height}px;">
                    ${showLabels ? label : ""}
               </div>`,
        iconSize: [size, height],
        iconAnchor: [size / 2, height / 2],
    });
}

function updateVehicles(vehicles) {
    const currentIds = new Set();

    vehicles.forEach((v) => {
        const id = v.vehicle_id || v.id;
        currentIds.add(id);

        // Filter check
        if (activeFilters.size > 0 && !activeFilters.has(v.route_id)) {
            if (vehicleMarkers[id]) {
                map.removeLayer(vehicleMarkers[id]);
                delete vehicleMarkers[id];
            }
            return;
        }

        const latlng = [v.lat, v.lon];

        if (vehicleMarkers[id]) {
            // Update existing marker position smoothly
            vehicleMarkers[id].setLatLng(latlng);
            vehicleMarkers[id].setIcon(createBusIcon(v));
        } else {
            // Create new marker
            const marker = L.marker(latlng, {
                icon: createBusIcon(v),
                zIndexOffset: 1000,
            });

            marker.on("click", () => showVehiclePopup(v, marker));
            marker.addTo(map);
            vehicleMarkers[id] = marker;
        }

        // Update stored data
        if (vehicleMarkers[id]) {
            vehicleMarkers[id]._vehicleData = v;
        }
    });

    // Remove stale markers
    Object.keys(vehicleMarkers).forEach((id) => {
        if (!currentIds.has(id)) {
            map.removeLayer(vehicleMarkers[id]);
            delete vehicleMarkers[id];
        }
    });

    // Update stats
    document.getElementById("vehicle-count").textContent = vehicles.length;
    document.getElementById("last-update").textContent = new Date().toLocaleTimeString("sv-SE");
}

function showVehiclePopup(vehicle, marker) {
    const color = getRouteColor({
        route_color: vehicle.route_color,
        route_short_name: vehicle.route_short_name,
        route_id: vehicle.route_id,
    });
    const textColor = vehicle.route_text_color
        ? `#${vehicle.route_text_color}`
        : "#fff";

    const speed = vehicle.speed
        ? `${(vehicle.speed * 3.6).toFixed(0)} km/h`
        : "Okänd";
    const bearing = vehicle.bearing !== null
        ? `${vehicle.bearing.toFixed(0)}°`
        : "Okänd";

    const html = `
        <div>
            <span class="popup-line-badge" style="background:${color}; color:${textColor}">
                ${vehicle.route_short_name || "?"}
            </span>
            <strong>${vehicle.route_long_name || ""}</strong>
            <br/>
            <small>Mot: ${vehicle.trip_headsign || "Okänt"}</small>
            <hr style="border-color:rgba(255,255,255,0.1); margin:6px 0"/>
            <small>
                Fordon: ${vehicle.label || vehicle.vehicle_id}<br/>
                Hastighet: ${speed}<br/>
                Riktning: ${bearing}
            </small>
        </div>
    `;
    marker.bindPopup(html, { maxWidth: 250 }).openPopup();
}

// --- Stops ---
function loadStops() {
    fetch(`${API_BASE}/stops/stations`)
        .then((r) => r.json())
        .then((data) => {
            stopsLayer = L.layerGroup();

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
                marker.bindPopup(
                    `<strong>${stop.stop_name}</strong><br/><small>${isStation ? "Station" : "Hållplats"}</small>`
                );
                stopsLayer.addLayer(marker);
            });

            if (showStops) {
                stopsLayer.addTo(map);
            }
        })
        .catch((err) => console.error("Error loading stops:", err));
}

// --- Route shapes ---
function loadShapes() {
    if (shapesLoaded) return;

    fetch(`${API_BASE}/routes/all`)
        .then((r) => r.json())
        .then((data) => {
            data.routes.forEach((r) => {
                routeData[r.route_id] = r;
            });
            document.getElementById("route-count").textContent = data.count;
            buildLineButtons(data.routes);
            return fetch(`${API_BASE}/shapes`);
        })
        .then((r) => r.json())
        .then((data) => {
            // We need to map shapes to routes via trips
            // For now, store all shapes for later route-specific loading
            shapesLoaded = true;
        })
        .catch((err) => console.error("Error loading shapes:", err));
}

function loadRouteShapes(routeId) {
    if (routeLayers[routeId]) return; // Already loaded

    fetch(`${API_BASE}/shapes/${routeId}`)
        .then((r) => r.json())
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

function toggleRouteShapes(visible) {
    if (visible) {
        // Load shapes for active routes
        const routeIds = activeFilters.size > 0
            ? [...activeFilters]
            : Object.keys(routeData);

        routeIds.forEach((rid) => {
            loadRouteShapes(rid);
            if (routeLayers[rid]) {
                routeLayers[rid].addTo(map);
            }
        });
    } else {
        Object.values(routeLayers).forEach((layer) => {
            map.removeLayer(layer);
        });
    }
}

// --- Line filter buttons ---
function buildLineButtons(routes) {
    const container = document.getElementById("line-buttons");
    container.innerHTML = "";

    // Sort by route_short_name numerically where possible
    const sorted = [...routes].sort((a, b) => {
        const na = parseInt(a.route_short_name);
        const nb = parseInt(b.route_short_name);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return (a.route_short_name || "").localeCompare(b.route_short_name || "");
    });

    sorted.forEach((route) => {
        const color = getRouteColor(route);
        const textColor = route.route_text_color
            ? `#${route.route_text_color}`
            : "#fff";

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
                // First filter: deactivate all, activate clicked
                document.querySelectorAll(".line-btn").forEach((b) =>
                    b.classList.add("inactive")
                );
                activeFilters.clear();
                sorted.forEach((r) => activeFilters.add(r.route_id));
                activeFilters.delete(route.route_id);
                // Now only show non-filtered (i.e., remove clicked from filter set)
                // Actually, let's use a simpler approach:
                // activeFilters = set of routes TO SHOW
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

            // If all are active again, clear filter
            if (activeFilters.size >= sorted.length) {
                activeFilters.clear();
                document.querySelectorAll(".line-btn").forEach((b) =>
                    b.classList.remove("inactive")
                );
            }

            // Reload route shapes if visible
            if (showRoutes) {
                Object.values(routeLayers).forEach((l) => map.removeLayer(l));
                toggleRouteShapes(true);
            }
        });

        container.appendChild(btn);
    });
}

// --- Alerts ---
function updateAlerts(alerts) {
    const container = document.getElementById("alerts-list");
    if (alerts.length === 0) {
        container.innerHTML = '<p style="color:#8e8e93; font-size:0.85em;">Inga aktiva störningar</p>';
        return;
    }

    container.innerHTML = alerts
        .map(
            (a) => `
        <div class="alert-item">
            <h4>${a.header}</h4>
            <p>${a.description}</p>
        </div>
    `
        )
        .join("");
}

// --- Polling ---
async function pollVehicles() {
    try {
        const resp = await fetch(`${API_BASE}/vehicles`);
        const data = await resp.json();
        updateVehicles(data.vehicles);
        updateAlerts([]); // Alerts are fetched separately
    } catch (err) {
        console.error("Error polling vehicles:", err);
    }
}

async function pollAlerts() {
    try {
        const resp = await fetch(`${API_BASE}/alerts`);
        const data = await resp.json();
        updateAlerts(data.alerts);
    } catch (err) {
        console.error("Error polling alerts:", err);
    }
}

// --- Controls ---
function initControls() {
    document.getElementById("toggle-stops").addEventListener("change", (e) => {
        showStops = e.target.checked;
        if (showStops && stopsLayer) {
            stopsLayer.addTo(map);
        } else if (stopsLayer) {
            map.removeLayer(stopsLayer);
        }
    });

    document.getElementById("toggle-routes").addEventListener("change", (e) => {
        showRoutes = e.target.checked;
        toggleRouteShapes(showRoutes);
    });

    document.getElementById("toggle-labels").addEventListener("change", (e) => {
        showLabels = e.target.checked;
        // Refresh all markers
        Object.values(vehicleMarkers).forEach((marker) => {
            if (marker._vehicleData) {
                marker.setIcon(createBusIcon(marker._vehicleData));
            }
        });
    });

    // Sidebar toggle
    const sidebar = document.getElementById("sidebar");
    const toggleBtn = document.getElementById("sidebar-toggle");
    toggleBtn.addEventListener("click", () => {
        sidebar.classList.toggle("hidden");
        toggleBtn.classList.toggle("shifted");
    });
}

// --- Init ---
async function init() {
    initMap();
    initControls();
    loadStops();
    loadShapes();

    await pollVehicles();
    await pollAlerts();

    // Start polling
    setInterval(pollVehicles, POLL_INTERVAL);
    setInterval(pollAlerts, 30000); // Alerts every 30s
}

document.addEventListener("DOMContentLoaded", init);
