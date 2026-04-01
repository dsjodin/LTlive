/**
 * api.js — Centralized API layer for LTlive.
 *
 * All fetch() calls and the SSE connection live here so the rest of the
 * codebase never has to construct URLs or parse raw responses itself.
 */

export const API_BASE = "/api";

export async function fetchStatus() {
    const r = await fetch(`${API_BASE}/status`);
    return r.json();
}

export async function fetchStats() {
    const r = await fetch(`${API_BASE}/stats`);
    return r.json();
}

export async function fetchVehicles() {
    const r = await fetch(`${API_BASE}/vehicles`);
    return r.json();
}

export async function fetchAlerts() {
    const r = await fetch(`${API_BASE}/alerts`);
    return r.json();
}

export async function fetchRoutes() {
    const r = await fetch(`${API_BASE}/routes/all`);
    return r.json();
}

export async function fetchTrainShapes() {
    const r = await fetch(`${API_BASE}/shapes/trains`);
    return r.json();
}

/**
 * @param {string[]} [routeIds]  When provided, only stops for those routes are returned.
 */
export async function fetchStops(routeIds) {
    const url = routeIds && routeIds.length > 0
        ? `${API_BASE}/stops?route_ids=${encodeURIComponent(routeIds.join(","))}`
        : `${API_BASE}/stops`;
    const r = await fetch(url);
    return r.json();
}

export async function fetchNextDepartures() {
    const r = await fetch(`${API_BASE}/stops/next-departure`);
    return r.json();
}

export async function fetchDepartures(stopId, limit, routeType) {
    const params = [];
    if (limit) params.push(`limit=${limit}`);
    if (routeType) params.push(`route_type=${encodeURIComponent(routeType)}`);
    const url = `${API_BASE}/departures/${encodeURIComponent(stopId)}${params.length ? "?" + params.join("&") : ""}`;
    const r = await fetch(url);
    return r.json();
}

export async function fetchShapeForRoute(routeId) {
    const r = await fetch(`${API_BASE}/shapes/${encodeURIComponent(routeId)}`);
    return r.json();
}

/**
 * @param {string[]} routeIds
 */
export async function fetchShapesBulk(routeIds) {
    const r = await fetch(
        `${API_BASE}/shapes/bulk?route_ids=${encodeURIComponent(routeIds.join(","))}`
    );
    return r.json();
}

export async function fetchLineDepartures(routeId) {
    const r = await fetch(`${API_BASE}/line-departures/${encodeURIComponent(routeId)}`);
    return r.json();
}

/**
 * @param {number} lat
 * @param {number} lon
 * @param {number} radius  Metres (50–5000)
 */
export async function fetchNearbyDepartures(lat, lon, radius) {
    const r = await fetch(
        `${API_BASE}/nearby-departures?lat=${lat}&lon=${lon}&radius=${radius}`
    );
    return r.json();
}

/** Return only parent stations (location_type=1). */
export async function fetchStations() {
    const r = await fetch(`${API_BASE}/stops/stations`);
    return r.json();
}

/**
 * @param {string} stopId
 * @param {number} [limit]
 * @param {string} [routeType]  e.g. "train"
 */
export async function fetchArrivals(stopId, limit, routeType) {
    let url = `${API_BASE}/arrivals/${encodeURIComponent(stopId)}`;
    const params = [];
    if (limit) params.push(`limit=${limit}`);
    if (routeType) params.push(`route_type=${encodeURIComponent(routeType)}`);
    if (params.length) url += `?${params.join("&")}`;
    const r = await fetch(url);
    return r.json();
}

/** @param {string} stopId */
export async function fetchStationMessages(stopId) {
    const r = await fetch(`${API_BASE}/station-messages/${encodeURIComponent(stopId)}`);
    return r.json();
}

export async function fetchWeather() {
    const r = await fetch(`${API_BASE}/weather`);
    if (!r.ok) throw new Error('Weather fetch failed');
    return r.json();
}

/**
 * Open an SSE connection to /api/stream.
 *
 * @param {(data: object) => void}      onVehicles       Full vehicles list event.
 * @param {(data: object) => void}      onAlerts         Alerts event.
 * @param {() => void}                  onError          Connection dropped.
 * @param {() => void}                  onOpen           Connection (re)opened.
 * @param {(data: object) => void}      [onVehiclesDelta] Incremental update event.
 * @param {(data: object) => void}      [onTraffic]      Traffic inference GeoJSON event.
 * @returns {EventSource}
 */
export function connectSSE(onVehicles, onAlerts, onError, onOpen, onVehiclesDelta, onTraffic, onConfig) {
    const source = new EventSource(`${API_BASE}/stream`);
    source.addEventListener("vehicles", (e) => {
        try { onVehicles(JSON.parse(e.data)); }
        catch (err) { console.error("SSE vehicles parse error:", err); }
    });
    source.addEventListener("alerts", (e) => {
        try { onAlerts(JSON.parse(e.data)); }
        catch (err) { console.error("SSE alerts parse error:", err); }
    });
    if (onVehiclesDelta) {
        source.addEventListener("vehicles_delta", (e) => {
            try { onVehiclesDelta(JSON.parse(e.data)); }
            catch (err) { console.error("SSE vehicles_delta parse error:", err); }
        });
    }
    if (onTraffic) {
        source.addEventListener("traffic", (e) => {
            try { onTraffic(JSON.parse(e.data)); }
            catch (err) { console.error("SSE traffic parse error:", err); }
        });
    }
    if (onConfig) {
        source.addEventListener("config", (e) => {
            try { onConfig(JSON.parse(e.data)); }
            catch (err) { console.error("SSE config parse error:", err); }
        });
    }
    if (onError) source.onerror = onError;
    if (onOpen)  source.onopen  = onOpen;
    return source;
}
