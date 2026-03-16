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
    marker.bindPopup(html, { maxWidth: 250 }).openPopup();
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
                marker.on("click", () => showStopDepartures(stop, marker));
                stopsLayer.addLayer(marker);
            });

            stopsLoaded = true;
            console.log(`Loaded ${data.count} stops`);

            if (showStops) {
                stopsLayer.addTo(map);
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
        });

        container.appendChild(btn);
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

// --- Controls ---
function initControls() {
    document.getElementById("toggle-stops").addEventListener("change", (e) => {
        showStops = e.target.checked;
        if (showStops) {
            if (!stopsLoaded) {
                loadStops();
            } else if (stopsLayer) {
                stopsLayer.addTo(map);
            }
        } else if (stopsLayer) {
            map.removeLayer(stopsLayer);
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

    // Check status first — loads stops/routes when GTFS is ready
    await checkStatus();

    await pollVehicles();
    await pollAlerts();

    // Start polling
    setInterval(pollVehicles, POLL_INTERVAL);
    setInterval(pollAlerts, 30000);
    // Keep checking if GTFS data has loaded (retry every 10s until loaded)
    const statusInterval = setInterval(async () => {
        await checkStatus();
        if (routesLoaded && stopsLoaded) {
            clearInterval(statusInterval);
        }
    }, 10000);
}

document.addEventListener("DOMContentLoaded", init);
