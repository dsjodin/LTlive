/**
 * traffic.js — Traffic inference layer and zone overlay.
 */

/* global L */

import state from "./state.js";

const TRAFFIC_COLORS = { none: "#888", low: "#FFD600", medium: "#FF9800", high: "#F44336" };

async function pollTraffic() {
    if (!state.showTraffic) return;
    try {
        const resp = await fetch("/api/traffic?min_confidence=0.3&min_severity=low");
        if (!resp.ok) return;
        const data = await resp.json();
        renderTrafficLayer(data);
    } catch (_) {}
}

export function renderTrafficLayer(geojson) {
    if (!state.trafficLayer) state.trafficLayer = L.layerGroup().addTo(state.map);
    state.trafficLayer.clearLayers();

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
        ).addTo(state.trafficLayer);
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
    if (!state.zoneLayer) state.zoneLayer = L.layerGroup().addTo(state.map);
    state.zoneLayer.clearLayers();

    for (const t of (data.terminal || [])) {
        L.circle([t.lat, t.lon], {
            radius: 40, color: "#a855f7", fillColor: "#a855f7",
            fillOpacity: 0.15, weight: 1.5, opacity: 0.7,
        }).bindTooltip("Ändhållplats", { sticky: true }).addTo(state.zoneLayer);
    }

    for (const s of (data.signal || [])) {
        L.circle([s.lat, s.lon], {
            radius: s.radius_m || 30, color: "#f97316", fillColor: "#f97316",
            fillOpacity: 0.15, weight: 1.5, opacity: 0.7,
        }).bindTooltip("Trafiksignal", { sticky: true }).addTo(state.zoneLayer);
    }
}

export function initTrafficLayer() {
    document.getElementById("traffic-btn").addEventListener("click", () => {
        state.showTraffic = !state.showTraffic;
        document.getElementById("traffic-btn").classList.toggle("active", state.showTraffic);
        document.getElementById("traffic-legend").classList.toggle("visible", state.showTraffic);
        if (state.showTraffic) {
            pollTraffic();
            state._trafficTimer = setInterval(pollTraffic, 30000);
        } else {
            clearInterval(state._trafficTimer);
            if (state.trafficLayer) state.trafficLayer.clearLayers();
            if (state.showZones) {
                state.showZones = false;
                document.getElementById("zone-overlay-btn").classList.remove("active");
                document.getElementById("zone-legend-rows").classList.remove("visible");
                if (state.zoneLayer) state.zoneLayer.clearLayers();
            }
        }
    });

    document.getElementById("zone-overlay-btn").addEventListener("click", () => {
        state.showZones = !state.showZones;
        document.getElementById("zone-overlay-btn").classList.toggle("active", state.showZones);
        document.getElementById("zone-legend-rows").classList.toggle("visible", state.showZones);
        if (state.showZones) {
            fetchZones();
        } else {
            if (state.zoneLayer) state.zoneLayer.clearLayers();
        }
    });
}
