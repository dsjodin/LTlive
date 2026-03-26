/**
 * vehicles.js — Vehicle marker creation, rendering, animation, and updates.
 */

/* global L, ALLOWED_LINE_NUMBERS, ALLOWED_TRAIN_IDS */

import state from "./state.js";
import { getRouteColor, getRouteTextColor, getLineStyle } from "./colors.js";

// --- Delay helpers ---

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

function getIconR() {
    const zoom = state.map ? state.map.getZoom() : 14;
    if (zoom <= 12) return 5;
    if (zoom <= 13) return 8;
    if (zoom <= 14) return 11;
    return 13;
}

// --- Haversine ---

export function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Bus icon ---

export function createBusIcon(vehicle) {
    const color = getRouteColor({
        route_color: vehicle.route_color,
        route_short_name: vehicle.route_short_name,
        route_id: vehicle.route_id,
    });
    const textColor = getRouteTextColor(vehicle);
    const label = vehicle.route_short_name || "";
    const bearing = vehicle.bearing;
    const hasBearing = bearing != null;
    const R = getIconR() + (label.length >= 3 ? 4 : label.length >= 2 ? 1 : 0);

    if (!state.showLabels || !label || R <= 6) {
        const d = R * 2;
        const dot = document.createElement("div");
        dot.className = "bus-icon-inner" + getDelayClass(vehicle);
        dot.style.width = `${d}px`;
        dot.style.height = `${d}px`;
        dot.style.borderRadius = "50%";
        dot.style.background = color;
        dot.style.border = `2px solid ${getDelayBorderColor(vehicle)}`;
        dot.style.boxShadow = "0 1px 4px rgba(0,0,0,.5)";
        return L.divIcon({ className: "bus-icon-wrapper", html: dot, iconSize: [d, d], iconAnchor: [R, R] });
    }

    const TIP = Math.round(R * 0.65);
    const W = (R + TIP) * 2;
    const CX = W / 2, CY = W / 2;
    const fs = Math.round(R * (label.length >= 3 ? 0.72 : label.length >= 2 ? 0.9 : 1.1));
    const borderColor = getDelayBorderColor(vehicle);
    const tipPath = hasBearing
        ? `<path d="M ${CX},${CY-R-TIP} L ${CX+Math.round(TIP*0.65)},${CY-R+Math.round(TIP*0.45)} L ${CX-Math.round(TIP*0.65)},${CY-R+Math.round(TIP*0.45)} Z" fill="${color}" stroke="${borderColor}" stroke-width="2" stroke-linejoin="round"/>`
        : "";
    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" class="vehicle-svg">
      <g transform="rotate(${hasBearing ? bearing : 0},${CX},${CY})">${tipPath}
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="${color}" stroke="${borderColor}" stroke-width="2.5"/>
      </g>
      <text x="${CX}" y="${CY}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" font-weight="800" fill="${textColor}" font-family="-apple-system,BlinkMacSystemFont,sans-serif" class="vehicle-svg-label">${label}</text>
    </svg>`;
    return L.divIcon({
        className: "bus-icon-wrapper",
        html: `<div class="bus-icon-inner icon-shadow${getDelayClass(vehicle)}">${svg}</div>`,
        iconSize: [W, W], iconAnchor: [CX, CY],
    });
}

// --- Train icon ---

export function createTrainIcon(vehicle) {
    const color = `#${vehicle.route_color || "E87722"}`;
    const textColor = `#${vehicle.route_text_color || "FFFFFF"}`;
    const label = vehicle.label || (vehicle.vehicle_id || "").split(".")[0] || "";
    const bearing = vehicle.bearing;
    const hasBearing = bearing != null;
    const zoom = state.map.getZoom();

    if (zoom <= 12) {
        const d = 10;
        const dot = document.createElement("div");
        dot.style.width = `${d}px`; dot.style.height = `${d}px`;
        dot.style.borderRadius = "2px"; dot.style.background = color;
        dot.style.border = "2px solid white"; dot.style.boxShadow = "0 1px 4px rgba(0,0,0,.5)";
        return L.divIcon({ className: "bus-icon-wrapper", html: dot, iconSize: [d, d], iconAnchor: [d/2, d/2] });
    }

    const W = 100, cx = 50, cy = 50;
    const lW = 36, lH = 16, cW = 24, cH = 12, gap = 4, noseLen = 8, noseHH = 7, rx = 4;
    const outlineColor = "#2A1010";
    const lx = cx - lW / 2, ly = cy - lH / 2;
    const c1x = lx - gap - cW, c2x = c1x - gap - cW;
    const cy_c = cy - cH / 2;
    const noseBaseX = lx + lW, noseTipX = noseBaseX + noseLen;
    const locoFill = color;
    const carriageFill = "#5C3030";
    const textFill = textColor;
    const outline = outlineColor;
    const rotation = hasBearing ? bearing - 90 : 0;
    const fs = label.length >= 4 ? 11 : label.length >= 3 ? 13 : 15;
    const noseSvg = `<path d="M ${noseTipX},${cy} L ${noseBaseX},${cy-noseHH} L ${noseBaseX},${cy+noseHH} Z" fill="${locoFill}" stroke="${outline}" stroke-width="2" stroke-linejoin="round"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" class="vehicle-svg">
  <g transform="rotate(${rotation},${cx},${cy})">
    <rect x="${c2x}" y="${cy_c}" width="${cW}" height="${cH}" rx="${rx}" ry="${rx}" fill="${carriageFill}" stroke="${outline}" stroke-width="2"/>
    <rect x="${c1x}" y="${cy_c}" width="${cW}" height="${cH}" rx="${rx}" ry="${rx}" fill="${carriageFill}" stroke="${outline}" stroke-width="2"/>
    <rect x="${lx}" y="${ly}" width="${lW}" height="${lH}" rx="${rx}" ry="${rx}" fill="${locoFill}" stroke="${outline}" stroke-width="2"/>${noseSvg}
  </g>
  <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" font-weight="800" fill="${textFill}" font-family="-apple-system,BlinkMacSystemFont,sans-serif" class="vehicle-svg-label">${label}</text>
</svg>`;
    return L.divIcon({
        className: "bus-icon-wrapper",
        html: `<div class="bus-icon-inner icon-shadow">${svg}</div>`,
        iconSize: [W, W], iconAnchor: [cx, cy],
    });
}

export function createVehicleIcon(vehicle) {
    return vehicle.vehicle_type === "train" ? createTrainIcon(vehicle) : createBusIcon(vehicle);
}

export function updateBusIconBearing(marker, bearing) {
    const el = marker.getElement();
    const g = el && el.querySelector("svg > g");
    if (!g) return;
    const svg = el.querySelector("svg");
    const W = svg ? parseFloat(svg.getAttribute("width")) : 0;
    if (!W) return;
    const CX = W / 2;
    const isTrain = marker._vehicleData && marker._vehicleData.vehicle_type === "train";
    const rotation = isTrain ? bearing - 90 : bearing;
    g.setAttribute("transform", `rotate(${rotation},${CX},${CX})`);
}

// --- Bearing snap (for trains) ---

function _distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = ax + t * dx, ey = ay + t * dy;
    return Math.sqrt((px - ex) ** 2 + (py - ey) ** 2);
}

function _bearingBetween(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

export function snapBearingToTrack(lat, lon) {
    let bestDist = Infinity, bestBearing = null;
    for (const coords of state.trainShapeCoords) {
        for (let i = 0; i < coords.length - 1; i++) {
            const [aLat, aLon] = coords[i];
            const [bLat, bLon] = coords[i + 1];
            const d = _distToSegment(lat, lon, aLat, aLon, bLat, bLon);
            if (d < bestDist) {
                bestDist = d;
                bestBearing = _bearingBetween(aLat, aLon, bLat, bLon);
            }
        }
    }
    return bestBearing;
}

// --- Animation ---

function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

export function startAnimLoop() {
    if (state.animFrameId) return;
    function frame(ts) {
        let hasActive = false;
        Object.entries(state.vehicleAnim).forEach(([id, anim]) => {
            const marker = state.vehicleMarkers[id];
            if (!marker) { delete state.vehicleAnim[id]; return; }
            const raw = Math.min(1, (ts - anim.startTime) / anim.duration);
            const t = easeInOut(raw);
            const lat = anim.fromLat + (anim.toLat - anim.fromLat) * t;
            const lon = anim.fromLon + (anim.toLon - anim.fromLon) * t;
            marker.setLatLng([lat, lon]);
            if (raw < 1) hasActive = true;
            else delete state.vehicleAnim[id];
        });
        state.animFrameId = hasActive ? requestAnimationFrame(frame) : null;
    }
    state.animFrameId = requestAnimationFrame(frame);
}

// --- Main vehicle update ---

export function updateVehicles(vehicles, { onDashboardUpdate } = {}) {
    const currentIds = new Set();
    const now = Date.now() / 1000;
    const map = state.map;

    vehicles.forEach((v) => {
        const id = v.vehicle_id || v.id;
        currentIds.add(id);

        const isTvTrain = v.vehicle_type === "train" && (v.vehicle_id || "").startsWith("tv_");
        const trainIdPrefix = v.vehicle_type === "train" ? (v.vehicle_id || "").split(".")[0] : null;
        if (isTvTrain ? false
                      : v.vehicle_type === "train" ? (typeof ALLOWED_TRAIN_IDS !== "undefined" && ALLOWED_TRAIN_IDS.size > 0 && !ALLOWED_TRAIN_IDS.has(trainIdPrefix))
                                                   : (typeof ALLOWED_LINE_NUMBERS !== "undefined" && ALLOWED_LINE_NUMBERS.size > 0 && !ALLOWED_LINE_NUMBERS.has(v.route_short_name))) {
            if (state.vehicleMarkers[id]) { map.removeLayer(state.vehicleMarkers[id]); delete state.vehicleMarkers[id]; }
            return;
        }

        if (state.activeFilters.size > 0 && !state.activeFilters.has(v.route_id)) {
            if (state.vehicleMarkers[id]) { map.removeLayer(state.vehicleMarkers[id]); delete state.vehicleMarkers[id]; }
            return;
        }

        const vType = v.vehicle_type === "train" ? "train" : "bus";
        if (state.hiddenTypes.has(vType)) {
            if (state.vehicleMarkers[id]) { map.removeLayer(state.vehicleMarkers[id]); delete state.vehicleMarkers[id]; }
            return;
        }

        // Calculate speed from position delta
        if (v.speed == null && state.vehicleMarkers[id] && state.vehicleMarkers[id]._vehicleData) {
            const prev = state.vehicleMarkers[id]._vehicleData;
            const dt = (v.timestamp || now) - (prev.timestamp || prev._localTime || 0);
            if (dt > 0 && dt < 120) {
                const dist = haversineDistance(prev.lat, prev.lon, v.lat, v.lon);
                if (dist > 2) v._calculatedSpeed = dist / dt;
            }
        }
        v._localTime = now;

        // Train activity & bearing state
        if (v.vehicle_type === "train") {
            const hasSpeedData = v.speed != null || v._calculatedSpeed != null;
            const speed = v.speed ?? v._calculatedSpeed ?? 0;
            const moving = speed > 0.5 && v.bearing != null;

            v._inactive = !hasSpeedData;

            if (moving) {
                state.vehicleLastBearing[id] = v.bearing;
            } else {
                if (state.trainShapeCoords.length > 0) {
                    v.bearing = snapBearingToTrack(v.lat, v.lon);
                } else {
                    v.bearing = state.vehicleLastBearing[id] ?? null;
                }
            }
        }

        if (state.vehicleMarkers[id]) {
            const cur = state.vehicleMarkers[id].getLatLng();
            const dist = haversineDistance(cur.lat, cur.lng, v.lat, v.lon);
            if (dist > 1) {
                state.vehicleAnim[id] = {
                    fromLat: cur.lat, fromLon: cur.lng,
                    toLat: v.lat, toLon: v.lon,
                    startTime: performance.now(),
                    duration: Math.min(state.POLL_INTERVAL * 0.95, 4000),
                };
                startAnimLoop();
            }

            // Update trail
            if (!state.vehicleTrailPoints[id]) state.vehicleTrailPoints[id] = [];
            state.vehicleTrailPoints[id].push([v.lat, v.lon]);
            if (state.vehicleTrailPoints[id].length > state.TRAIL_MAX_POINTS) state.vehicleTrailPoints[id].shift();
            const trailColor = getRouteColor({ route_color: v.route_color, route_short_name: v.route_short_name, route_id: v.route_id });
            if (state.vehicleTrails[id] && state.vehicleTrailPoints[id].length >= 2) {
                state.vehicleTrails[id].setLatLngs(state.vehicleTrailPoints[id]);
            } else if (!state.vehicleTrails[id] && state.vehicleTrailPoints[id].length >= 2) {
                state.vehicleTrails[id] = L.polyline(state.vehicleTrailPoints[id], {
                    color: trailColor, weight: 3, opacity: 0.45, dashArray: "4 5",
                }).addTo(map);
            }

            const prev = state.vehicleMarkers[id]._vehicleData;
            const colorChanged = !prev || prev.route_short_name !== v.route_short_name || prev.route_color !== v.route_color;
            if (colorChanged) {
                state.vehicleMarkers[id].setIcon(createVehicleIcon(v));
            } else if (v.bearing != null) {
                updateBusIconBearing(state.vehicleMarkers[id], v.bearing);
            }
        } else {
            const marker = L.marker([v.lat, v.lon], { icon: createVehicleIcon(v), zIndexOffset: 1000 });
            marker.on("click", () => {
                const current = marker._vehicleData || v;
                // Vehicle popup is handled by the panels module
                if (typeof window._showVehiclePopup === "function") {
                    window._showVehiclePopup(current, marker);
                }
            });
            marker.addTo(map);
            state.vehicleMarkers[id] = marker;
        }

        state.vehicleMarkers[id]._vehicleData = v;
    });

    // Remove stale markers
    Object.keys(state.vehicleMarkers).forEach((id) => {
        if (currentIds.has(id)) return;
        const data = state.vehicleMarkers[id]._vehicleData;
        const isTrain = data && data.vehicle_type === "train";
        const staleAfter = isTrain ? 300 : 60;
        const lastSeen = (data && data._localTime) || 0;
        if (now - lastSeen < staleAfter) return;
        map.removeLayer(state.vehicleMarkers[id]);
        delete state.vehicleMarkers[id];
        delete state.vehicleAnim[id];
        delete state.vehicleLastBearing[id];
        delete state.vehicleTrailPoints[id];
        if (state.vehicleTrails[id]) { map.removeLayer(state.vehicleTrails[id]); delete state.vehicleTrails[id]; }
    });

    document.getElementById("vehicle-count").textContent = vehicles.length;
    document.getElementById("last-update").textContent = new Date().toLocaleTimeString("sv-SE");
    if (onDashboardUpdate) onDashboardUpdate(vehicles);
}
