/**
 * stops.js — Stop loading, departure badges, route shapes, and train routes.
 */

/* global L, ALLOWED_LINE_NUMBERS */

import state from "./state.js";
import { getRouteColor } from "./colors.js";
import {
    fetchStops, fetchRoutes, fetchTrainShapes,
    fetchShapeForRoute, fetchShapesBulk,
    fetchNextDepartures,
} from "./api.js";

// --- Train shape geometry helpers ---

function _distToSegment(lat, lon, lat1, lon1, lat2, lon2) {
    const dx = lat2 - lat1, dy = lon2 - lon1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(lat - lat1, lon - lon1);
    const t = Math.max(0, Math.min(1, ((lat - lat1) * dx + (lon - lon1) * dy) / lenSq));
    return Math.hypot(lat - (lat1 + t * dx), lon - (lon1 + t * dy));
}

function _bearingBetween(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function snapBearingToTrack(lat, lon) {
    let minDist = Infinity, snapBearing = null;
    for (const coords of state.trainShapeCoords) {
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

// --- Stop loading ---

export function loadStops() {
    if (state.stopsLoaded) return;

    const routeIds = Object.keys(state.routeData);

    fetchStops(routeIds)
        .then((data) => {
            if (data.count === 0) {
                console.log("No stops returned (GTFS static may not be loaded yet)");
                return;
            }

            state.stopsLayer = L.layerGroup();
            state.stopMarkerMap = {};

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
                marker.on("popupopen", () => {
                    if (window._showStopDepartures) window._showStopDepartures(stop, marker);
                });
                state.stopsLayer.addLayer(marker);
                state.stopMarkerMap[stop.stop_id] = marker;
            });

            state.stopsLoaded = true;
            console.log(`Loaded ${data.count} stops`);

            if (state.showStops) {
                state.stopsLayer.addTo(state.map);
                pollStopDepartures();
            }
        })
        .catch((err) => console.error("Error loading stops:", err));
}

// --- Route loading ---

export function loadRoutes(onRoutesLoaded) {
    if (state.routesLoaded) return;

    fetchRoutes()
        .then((data) => {
            if (data.count === 0) {
                console.log("No routes returned (GTFS static may not be loaded yet)");
                return;
            }

            state.routeData = {};
            const filtered = ALLOWED_LINE_NUMBERS.size > 0
                ? data.routes.filter(r => ALLOWED_LINE_NUMBERS.has(r.route_short_name))
                : data.routes;
            filtered.forEach((r) => {
                state.routeData[r.route_id] = r;
            });
            document.getElementById("route-count").textContent = filtered.length;
            state.routesLoaded = true;
            console.log(`Loaded ${filtered.length} / ${data.count} routes (filtered by config)`);

            if (onRoutesLoaded) onRoutesLoaded(filtered);
        })
        .catch((err) => console.error("Error loading routes:", err));
}

// --- Train routes ---

export function loadTrainRoutes() {
    if (state.trainRoutesLoaded) return;
    fetchTrainShapes()
        .then(data => {
            if (!data.count) return;
            const layerGroup = L.layerGroup();
            Object.values(data.shapes).forEach(coords => {
                state.trainShapeCoords.push(coords);
                L.polyline(coords, { color: "#7A3A00", weight: 6, opacity: 0.6, lineCap: "round", lineJoin: "round", smoothFactor: 0.5 }).addTo(layerGroup);
                L.polyline(coords, { color: "#E87722", weight: 3, opacity: 0.9, lineCap: "round", lineJoin: "round", smoothFactor: 0.5 }).addTo(layerGroup);
            });
            state.trainRailLayer = layerGroup;
            layerGroup.addTo(state.map);
            state.trainRoutesLoaded = true;
            console.log(`Loaded ${data.count} deduplicated train shapes`);
        })
        .catch(err => console.error("Error loading train routes:", err));
}

// --- Route shapes ---

export function loadRouteShapes(routeId) {
    if (state.routeLayers[routeId]) {
        if (state.showRoutes && !state.map.hasLayer(state.routeLayers[routeId])) {
            state.routeLayers[routeId].addTo(state.map);
        }
        return Promise.resolve();
    }

    return fetchShapeForRoute(routeId)
        .then((data) => {
            const route = state.routeData[routeId] || {};
            const color = getRouteColor(route);
            const layerGroup = L.layerGroup();

            Object.values(data.shapes).forEach((coords) => {
                L.polyline(coords, { color, weight: 3, opacity: 0.7, lineCap: "round", lineJoin: "round", smoothFactor: 0.5 }).addTo(layerGroup);
            });

            state.routeLayers[routeId] = layerGroup;
            if (state.showRoutes) layerGroup.addTo(state.map);
        })
        .catch((err) => console.error(`Error loading shapes for ${routeId}:`, err));
}

export async function toggleRouteShapes(visible) {
    if (!visible) {
        Object.values(state.routeLayers).forEach((layer) => state.map.removeLayer(layer));
        return;
    }

    const routeIds = state.activeFilters.size > 0
        ? [...state.activeFilters]
        : Object.keys(state.routeData);

    const toFetch = routeIds.filter((rid) => {
        if (state.routeLayers[rid]) {
            if (state.showRoutes && !state.map.hasLayer(state.routeLayers[rid])) state.routeLayers[rid].addTo(state.map);
            return false;
        }
        return true;
    });

    if (toFetch.length === 0) return;

    if (toFetch.length === 1) {
        loadRouteShapes(toFetch[0]);
        return;
    }

    try {
        const data = await fetchShapesBulk(toFetch);
        Object.entries(data.routes).forEach(([routeId, shapeCoordsList]) => {
            const route = state.routeData[routeId] || {};
            const color = getRouteColor(route);
            const layerGroup = L.layerGroup();
            shapeCoordsList.forEach((coords) => {
                L.polyline(coords, { color, weight: 3, opacity: 0.7, lineCap: "round", lineJoin: "round", smoothFactor: 0.5 }).addTo(layerGroup);
            });
            state.routeLayers[routeId] = layerGroup;
            if (state.showRoutes) layerGroup.addTo(state.map);
        });
    } catch (err) {
        console.error("Error loading shapes (bulk):", err);
    }
}

// --- Stop departure badges ---

export async function pollStopDepartures() {
    if (!state.stopsLoaded || !state.showStops) return;
    try {
        const data = await fetchNextDepartures();
        state.stopNextDep = data;
        updateStopBadges();
    } catch (err) {
        console.error("Error polling stop departures:", err);
    }
}

export function updateStopBadges() {
    if (!state.stopsLoaded) return;
    const zoom = state.map ? state.map.getZoom() : 0;
    const showBadges = state.showStops && zoom >= state.BADGE_MIN_ZOOM;

    Object.entries(state.stopMarkerMap).forEach(([stopId, marker]) => {
        const stop = marker._stopData;
        if (!stop) return;
        const isStation = stop.location_type === 1;
        const dep = state.stopNextDep[stopId];

        let iconEl, iconSize, iconAnchor;
        if (dep && showBadges) {
            const min   = dep.minutes;
            const label = min === 0 ? "Nu" : `${min}m`;
            const bg    = dep.route_color    || "0074D9";
            const fg    = dep.route_text_color || "FFFFFF";

            const wrap = document.createElement("div");
            wrap.className = "stop-badge-wrap";
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
