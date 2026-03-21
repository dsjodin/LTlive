/**
 * mapCore.js — Leaflet map initialization and tile management.
 */

/* global L */

import state from "./state.js";

const TILES = {
    dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
};

export function initMap() {
    state.map = L.map("map", {
        center: state.MAP_CENTER,
        zoom: state.MAP_ZOOM,
        zoomControl: true,
    });

    setTileLayer(state.darkMode);
    document.body.classList.toggle("light-mode", !state.darkMode);
    const dmToggle = document.getElementById("toggle-darkmode");
    if (dmToggle) dmToggle.checked = state.darkMode;
}

export function setTileLayer(isDark) {
    if (state.tileLayer) state.map.removeLayer(state.tileLayer);
    state.tileLayer = L.tileLayer(isDark ? TILES.dark : TILES.light, {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | Data: <a href="https://trafiklab.se">Trafiklab</a>',
        subdomains: "abcd",
        maxZoom: 19,
    });
    state.tileLayer.addTo(state.map);
}

export function addDriftsplatsOverlay() {
    L.polygon([
        [59.2660, 15.1950], [59.2660, 15.2440],
        [59.3000, 15.2220], [59.3000, 15.1960],
    ], {
        color: "#f59e0b", weight: 2, dashArray: "6 4",
        fillColor: "#f59e0b", fillOpacity: 0.06, interactive: false,
    }).addTo(state.map).bindTooltip("Örc driftsplats — ungefärlig gräns", { sticky: true });

    L.circleMarker([59.2995, 15.2215], {
        radius: 7, color: "#ef4444", fillColor: "#ef4444", fillOpacity: 0.9, weight: 2,
    }).addTo(state.map).bindTooltip("Infartssignal Ör 121");

    L.circle(state.MAP_CENTER, {
        radius: 600, color: "#22c55e", weight: 2, dashArray: "4 4",
        fillColor: "#22c55e", fillOpacity: 0.05, interactive: false,
    }).addTo(state.map).bindTooltip("600 m GPS-tröskel (gps_at_station)");
}
