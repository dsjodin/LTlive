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
let vehicleMarkers = {};
let routeLayers = {};
let routeData = {};
let activeFilters = new Set();
let showStops = false;
let showRoutes = false;
let showLabels = true;
let darkMode = true;
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

// Stop departure badges
let stopMarkerMap = {};   // stop_id -> L.marker
let stopNextDep = {};     // stop_id -> {minutes, route_short_name, route_color, route_text_color}
const BADGE_MIN_ZOOM = 15;

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

function getRouteTextColor(route) {
    const custom = getLineStyle(route.route_short_name);
    if (custom) return `#${custom.text}`;
    return route.route_text_color ? `#${route.route_text_color}` : "#fff";
}

// --- Map Init ---
function initMap() {
    map = L.map("map", {
        center: OREBRO_CENTER,
        zoom: DEFAULT_ZOOM,
        zoomControl: true,
    });

    setTileLayer(darkMode);

    // Rescale icons when zoom changes
    map.on("zoomend", () => {
        Object.values(vehicleMarkers).forEach(m => {
            if (m._vehicleData) m.setIcon(createBusIcon(m._vehicleData));
        });
        updateStopBadges();
    });
}

function setTileLayer(isDark) {
    if (tileLayer) {
        map.removeLayer(tileLayer);
    }
    tileLayer = L.tileLayer(isDark ? TILES.dark : TILES.light, {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | Data: <a href="https://trafiklab.se">Trafiklab</a>',
        subdomains: "abcd",
        maxZoom: 19,
    });
    tileLayer.addTo(map);
}

// --- Bus markers ---

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
        // Tiny dot at low zoom / labels off
        const d = R * 2;
        return L.divIcon({
            className: "bus-icon-wrapper",
            html: `<div class="bus-icon-inner" style="width:${d}px;height:${d}px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
            iconSize: [d, d],
            iconAnchor: [R, R],
        });
    }

    // Circle with directional arrowhead (SVG)
    const TIP = Math.round(R * 0.65);
    const W = (R + TIP) * 2;
    const CX = W / 2, CY = W / 2;
    const fs = Math.round(R * (label.length >= 3 ? 0.72 : label.length >= 2 ? 0.9 : 1.1));

    const tipPath = hasBearing
        ? `<path d="M ${CX},${CY-R-TIP} L ${CX+Math.round(TIP*0.65)},${CY-R+Math.round(TIP*0.45)} L ${CX-Math.round(TIP*0.65)},${CY-R+Math.round(TIP*0.45)} Z"
                  fill="${color}" stroke="white" stroke-width="2" stroke-linejoin="round"/>`
        : "";

    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"
         style="overflow:visible;display:block">
      <g transform="rotate(${hasBearing ? bearing : 0},${CX},${CY})">
        ${tipPath}
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="${color}" stroke="white" stroke-width="2.5"/>
      </g>
      <text x="${CX}" y="${CY}" text-anchor="middle" dominant-baseline="central"
            font-size="${fs}" font-weight="800" fill="${textColor}"
            font-family="-apple-system,BlinkMacSystemFont,sans-serif"
            style="user-select:none;pointer-events:none">${label}</text>
    </svg>`;

    return L.divIcon({
        className: "bus-icon-wrapper",
        html: `<div class="bus-icon-inner" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))">${svg}</div>`,
        iconSize: [W, W],
        iconAnchor: [CX, CY],
    });
}

// Update bearing in-place without recreating the DOM element (avoids click flicker).
function updateBusIconBearing(marker, bearing) {
    const el = marker.getElement();
    const g = el && el.querySelector("svg > g");
    if (!g) return;
    // Read actual SVG size from DOM so CX is always correct regardless of label length
    const svg = el.querySelector("svg");
    const W = svg ? parseFloat(svg.getAttribute("width")) : 0;
    if (!W) return;
    const CX = W / 2;
    g.setAttribute("transform", `rotate(${bearing},${CX},${CX})`);
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

function updateVehicles(vehicles) {
    const currentIds = new Set();
    const now = Date.now() / 1000;

    vehicles.forEach((v) => {
        const id = v.vehicle_id || v.id;
        currentIds.add(id);

        // Skip vehicles not in our configured lines
        if (ALLOWED_LINE_NUMBERS.size > 0 && !ALLOWED_LINE_NUMBERS.has(v.route_short_name)) {
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

        if (vehicleMarkers[id]) {
            vehicleMarkers[id].setLatLng(latlng);

            const prev = vehicleMarkers[id]._vehicleData;
            const colorChanged = !prev || prev.route_short_name !== v.route_short_name ||
                                 prev.route_color !== v.route_color;
            if (colorChanged) {
                vehicleMarkers[id].setIcon(createBusIcon(v));
            } else if (v.bearing != null) {
                // Rotate the existing SVG in-place — avoids DOM recreation and click flicker
                updateBusIconBearing(vehicleMarkers[id], v.bearing);
            }
        } else {
            const marker = L.marker(latlng, {
                icon: createBusIcon(v),
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

    // Remove markers for vehicles no longer in the feed
    Object.keys(vehicleMarkers).forEach((id) => {
        if (!currentIds.has(id)) {
            map.removeLayer(vehicleMarkers[id]);
            delete vehicleMarkers[id];
        }
    });

    document.getElementById("vehicle-count").textContent = vehicles.length;
    document.getElementById("last-update").textContent = new Date().toLocaleTimeString("sv-SE");
}

// --- Stop departure board ---
function showStopDepartures(stop, marker) {
    const loadingHtml = `
        <div class="popup-stop">
            <div class="popup-stop-name">${stop.stop_name}</div>
            <div class="dep-loading">Hämtar avgångar…</div>
        </div>`;
    marker.bindPopup(loadingHtml, { maxWidth: 320 }).openPopup();

    fetch(`${API_BASE}/departures/${encodeURIComponent(stop.stop_id)}`)
        .then((r) => r.json())
        .then((data) => {
            let html;
            if (!data.departures || data.departures.length === 0) {
                html = `
                    <div class="popup-stop">
                        <div class="popup-stop-name">${stop.stop_name}</div>
                        <div class="dep-empty">Inga kommande avgångar</div>
                    </div>`;
            } else {
                const now = Date.now() / 1000;
                const rows = data.departures.map((d) => {
                    const mins = Math.round((d.departure_time - now) / 60);
                    const timeStr = mins <= 0 ? "Nu" : `${mins} min`;
                    const clock = new Date(d.departure_time * 1000)
                        .toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
                    const custom = getLineStyle(d.route_short_name);
                    const bg = custom ? `#${custom.bg}` : `#${d.route_color}`;
                    const fg = custom ? `#${custom.text}` : `#${d.route_text_color}`;
                    const rt = d.is_realtime
                        ? '<span class="dep-rt" title="Realtid">RT</span>'
                        : "";
                    return `
                        <tr>
                            <td><span class="dep-badge" style="background:${bg};color:${fg}">${d.route_short_name}</span></td>
                            <td class="dep-headsign">${d.headsign}</td>
                            <td class="dep-time">${timeStr}${rt}</td>
                            <td class="dep-clock">${clock}</td>
                        </tr>`;
                }).join("");
                html = `
                    <div class="popup-stop">
                        <div class="popup-stop-name">${stop.stop_name}</div>
                        <table class="dep-table"><tbody>${rows}</tbody></table>
                    </div>`;
            }
            if (marker.isPopupOpen()) marker.setPopupContent(html);
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

function showVehiclePopup(vehicle, marker) {
    const color = getRouteColor({
        route_color: vehicle.route_color,
        route_short_name: vehicle.route_short_name,
        route_id: vehicle.route_id,
    });

    const lineName = vehicle.route_short_name || "?";
    let headsign = vehicle.trip_headsign || "";

    // If headsign is a "A - B" route name, show it as-is after "Buss X"
    const isRouteName = headsign.includes(" - ");
    let title;
    if (headsign && !isRouteName) {
        title = `Buss ${lineName} mot ${headsign}`;
    } else if (headsign && isRouteName) {
        title = `Buss ${lineName} ${headsign}`;
    } else {
        title = `Buss ${lineName}`;
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
    const nextStopLabel = vehicle.current_status === "Vid hållplats"
        ? "Vid hållplats"
        : "Nästa hållplats";

    const html = `
        <div class="popup-vehicle">
            <div class="popup-title" style="color:${color}">
                ${title}
            </div>
            <div class="popup-details">
                ${nextStop ? `${nextStopLabel}: ${nextStop}<br/>` : ""}
                ${speed ? `Hastighet: ${speed}<br/>` : ""}
                Uppdaterad: ${updatedAt}
            </div>
        </div>
    `;
    L.popup({ maxWidth: 250 })
        .setLatLng(marker.getLatLng())
        .setContent(html)
        .openOn(map);
}

// --- Stops ---
function loadStops() {
    if (stopsLoaded) return;

    const routeIds = Object.keys(routeData);
    const url = routeIds.length > 0
        ? `${API_BASE}/stops?route_ids=${encodeURIComponent(routeIds.join(","))}`
        : `${API_BASE}/stops`;

    fetch(url)
        .then((r) => r.json())
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
                marker.on("click", () => showStopDepartures(stop, marker));
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

    fetch(`${API_BASE}/routes/all`)
        .then((r) => r.json())
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
            routesLoaded = true;
            console.log(`Loaded ${filtered.length} / ${data.count} routes (filtered by config)`);

            // Load stops now that we know which route_ids to filter on
            if (!stopsLoaded) {
                loadStops();
            }
        })
        .catch((err) => console.error("Error loading routes:", err));
}


function loadRouteShapes(routeId) {
    if (routeLayers[routeId]) {
        if (showRoutes && !map.hasLayer(routeLayers[routeId])) {
            routeLayers[routeId].addTo(map);
        }
        return Promise.resolve();
    }

    return fetch(`${API_BASE}/shapes/${routeId}`)
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
        const routeIds = activeFilters.size > 0
            ? [...activeFilters]
            : Object.keys(routeData);

        routeIds.forEach((rid) => loadRouteShapes(rid));
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

// --- Line departure panel ---
function openLinePanel(route) {
    activePanelRouteId = route.route_id;

    const color = getRouteColor(route);
    const textColor = getRouteTextColor(route);
    document.getElementById("line-panel-title").innerHTML =
        `<span class="dep-badge" style="background:${color};color:${textColor}">${route.route_short_name}</span>` +
        `<span class="lp-route-name">${route.route_long_name || ""}</span>`;
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
}

function fetchLineDepartures(routeId) {
    fetch(`${API_BASE}/line-departures/${encodeURIComponent(routeId)}`)
        .then(r => r.json())
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

// --- Alerts → bottom ticker ---
function updateAlerts(alerts) {
    const el = document.getElementById("ticker-content");
    if (!el) return;
    if (alerts.length === 0) {
        el.textContent = "Inga aktiva störningar";
        el.className = "ticker-move no-alerts";
        return;
    }
    const text = alerts.map((a) => `⚠  ${a.header}${a.description ? " — " + a.description : ""}`).join("          ◆          ");
    el.textContent = text;
    // Measure after content is set; restart animation with exact pixel positions
    // so the text fully exits before looping.
    el.style.animation = "none";
    el.className = "ticker-move has-alerts";
    requestAnimationFrame(() => {
        const wrapW = el.parentElement.offsetWidth;
        const textW = el.scrollWidth;
        const px_per_sec = 80;
        const dur = (wrapW + textW) / px_per_sec;
        el.style.setProperty("--ticker-from", `${wrapW}px`);
        el.style.setProperty("--ticker-to", `${-textW}px`);
        el.style.setProperty("--ticker-dur", `${dur}s`);
        el.style.animation = "";
    });
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
        const resp = await fetch(`${API_BASE}/status`);
        const data = await resp.json();

        if (data.gtfs_error) {
            showStatusBanner(`GTFS-data kunde inte laddas: ${data.gtfs_error}`);
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
    } catch (err) {
        console.error("Error checking status:", err);
    }
}

// --- Polling ---
async function pollVehicles() {
    try {
        const resp = await fetch(`${API_BASE}/vehicles`);
        const data = await resp.json();
        updateVehicles(data.vehicles);
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

async function pollStopDepartures() {
    if (!stopsLoaded || !showStops) return;
    try {
        const data = await fetch(`${API_BASE}/stops/next-departure`).then(r => r.json());
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

        let iconHtml, iconSize, iconAnchor;
        if (dep && showBadges) {
            const min = dep.minutes;
            const label = min === 0 ? "Nu" : `${min}m`;
            const bg = dep.route_color || "0074D9";
            const fg = dep.route_text_color || "FFFFFF";
            const dotClass = isStation ? "station-marker" : "stop-marker";
            iconHtml = `<div style="display:flex;align-items:center;gap:3px;pointer-events:none">` +
                `<div class="${dotClass}" style="flex-shrink:0"></div>` +
                `<span class="stop-badge-pill" style="background:#${bg};color:#${fg}">${dep.route_short_name}&nbsp;${label}</span>` +
                `</div>`;
            iconSize = isStation ? [80, 14] : [72, 10];
            iconAnchor = isStation ? [6, 7] : [4, 5];
        } else {
            const dotClass = isStation ? "station-marker" : "stop-marker";
            iconHtml = `<div class="${dotClass}"></div>`;
            iconSize = isStation ? [12, 12] : [8, 8];
            iconAnchor = isStation ? [6, 6] : [4, 4];
        }

        marker.setIcon(L.divIcon({ className: "", html: iconHtml, iconSize, iconAnchor }));
    });
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
    fetch(`${API_BASE}/nearby-departures?lat=${lat}&lon=${lon}&radius=400`)
        .then(r => r.json())
        .then(data => {
            if (!nearbyPanelOpen) return;
            if (!data.stops || data.stops.length === 0) {
                body.innerHTML = `<div class="nearby-empty">Inga hållplatser inom 400 m</div>`;
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
                        <span class="dep-badge" style="background:${bg};color:${fg}">${d.route_short_name}</span>
                        <span class="nearby-headsign">${d.headsign}</span>
                        <span class="${minClass}">${minStr}</span>
                        ${rt}
                    </div>`;
                }).join("") || `<div class="nearby-nodep">Inga avgångar</div>`;
                return `<div class="nearby-stop">
                    <div class="nearby-stop-header">
                        <span class="nearby-stop-name">${stop.stop_name}</span>
                        <span class="nearby-dist">${distStr}</span>
                    </div>
                    ${deps}
                </div>`;
            }).join("");
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
        setTileLayer(darkMode);
        document.body.classList.toggle("light-mode", !darkMode);
    });

    // Line panel close
    document.getElementById("line-panel-close").addEventListener("click", closeLinePanel);

    // Hamburger (mobile: toggles controls dropdown)
    document.getElementById("hamburger-btn").addEventListener("click", () => {
        const ctrl = document.getElementById("topbar-controls");
        const btn = document.getElementById("hamburger-btn");
        const open = ctrl.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // Ticker collapse / reopen
    document.getElementById("ticker-toggle").addEventListener("click", () => {
        document.getElementById("bottom-ticker").classList.add("collapsed");
        document.body.classList.add("ticker-collapsed");
        map.invalidateSize();
    });
    document.getElementById("ticker-reopener").addEventListener("click", () => {
        document.getElementById("bottom-ticker").classList.remove("collapsed");
        document.body.classList.remove("ticker-collapsed");
        map.invalidateSize();
    });

}

// --- Init ---
async function init() {
    initMap();
    initControls();
    initGps();

    // Check status first — loads stops/routes when GTFS is ready
    await checkStatus();

    await pollVehicles();
    await pollAlerts();

    // Start polling
    setInterval(pollVehicles, POLL_INTERVAL);
    setInterval(pollAlerts, 30000);
    setInterval(pollStopDepartures, 60000);
    // Keep checking if GTFS data has loaded (retry every 10s until loaded)
    const statusInterval = setInterval(async () => {
        await checkStatus();
        if (routesLoaded && stopsLoaded) {
            clearInterval(statusInterval);
        }
    }, 10000);
}

document.addEventListener("DOMContentLoaded", init);
