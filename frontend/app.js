/**
 * LTlive - Live bus tracking for Örebro
 * Leaflet map with GTFS-RT vehicle positions
 *
 * Orchestrator — imports and wires all modules together.
 */

import state from "./modules/state.js";
import { initMap, setTileLayer, addDriftsplatsOverlay } from "./modules/mapCore.js";
import { createVehicleIcon, updateVehicles } from "./modules/vehicles.js";
import { loadStops, loadRoutes, loadTrainRoutes, toggleRouteShapes, pollStopDepartures, updateStopBadges } from "./modules/stops.js";
import { closeAllPanels, showStopDepartures, showVehiclePopup, startEtaCountdown, openLinePanel, closeStopPanel, closeLinePanel } from "./modules/panels.js";
import { buildLineButtons, renderFilterChips, initTypeFilterButtons } from "./modules/filters.js";
import { toggleFavorite, toggleSavedTrip, initFavoritesPanel, closeFavoritesPanel } from "./modules/favorites.js";
import { initGps, closeNearbyPanel } from "./modules/nearby.js";
import { initDelaysPanel } from "./modules/delays.js";
import { initTrafficLayer } from "./modules/traffic.js";
import { updateDashboard, updateAlerts, updateDashboardAlerts, renderDashboardFavorites } from "./modules/dashboard.js";
import { initSSE } from "./modules/sse.js";
import { updateWeather, initWeatherWidget } from "./modules/weather.js";
import {
    fetchStatus, fetchVehicles, fetchAlerts,
} from "./modules/api.js";

// --- Wire cross-module callbacks via window ---
// Modules use window._xxx callbacks to avoid circular imports.
window._showStopDepartures = showStopDepartures;
window._showVehiclePopup = showVehiclePopup;
window._toggleFavorite = toggleFavorite;
window._toggleSavedTrip = toggleSavedTrip;
window._closeNearbyPanel = closeNearbyPanel;
window._closeFavoritesPanel = closeFavoritesPanel;
window._renderFilterChips = renderFilterChips;
window._updateDashboardAlerts = updateDashboardAlerts;
window._renderDashboardFavorites = renderDashboardFavorites;

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
    if (banner) banner.style.display = "none";
}

// --- Check backend status ---

async function checkStatus() {
    try {
        const data = await fetchStatus();

        if (data.nearby_radius_meters) state.nearbyRadius = data.nearby_radius_meters;
        if (data.frontend_poll_interval_ms) state.POLL_INTERVAL = data.frontend_poll_interval_ms;

        if (data.gtfs_error) {
            showStatusBanner("GTFS-data kunde inte laddas. Kontrollera serverloggen.");
            return;
        }

        if (data.routes_count === 0) {
            showStatusBanner("Laddar GTFS-data (linjer, hållplatser)...");
            return;
        }

        hideStatusBanner();

        if (!state.routesLoaded) {
            loadRoutes((filtered) => {
                buildLineButtons(filtered);
                initTypeFilterButtons();
                if (state.showRoutes) toggleRouteShapes(true);
                if (!state.stopsLoaded) loadStops();
            });
        }
        if (!state.trainRoutesLoaded) {
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
        updateVehicles(data.vehicles, { onDashboardUpdate: updateDashboard });
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

// --- Controls ---

function initControls() {
    document.getElementById("toggle-stops").addEventListener("change", (e) => {
        state.showStops = e.target.checked;
        if (state.showStops) {
            if (!state.stopsLoaded) {
                loadStops();
            } else if (state.stopsLayer) {
                state.stopsLayer.addTo(state.map);
                pollStopDepartures();
            }
        } else if (state.stopsLayer) {
            state.map.removeLayer(state.stopsLayer);
            updateStopBadges();
        }
    });

    document.getElementById("toggle-routes").addEventListener("change", (e) => {
        state.showRoutes = e.target.checked;
        if (state.showRoutes && !state.routesLoaded) {
            loadRoutes((filtered) => {
                buildLineButtons(filtered);
                initTypeFilterButtons();
                toggleRouteShapes(true);
                if (!state.stopsLoaded) loadStops();
            });
        }
        toggleRouteShapes(state.showRoutes);
    });

    document.getElementById("toggle-labels").addEventListener("change", (e) => {
        state.showLabels = e.target.checked;
        Object.values(state.vehicleMarkers).forEach((marker) => {
            if (marker._vehicleData) {
                marker.setIcon(createVehicleIcon(marker._vehicleData));
            }
        });
    });

    document.getElementById("toggle-darkmode").addEventListener("change", (e) => {
        state.darkMode = e.target.checked;
        localStorage.setItem("darkMode", state.darkMode);
        setTileLayer(state.darkMode);
        document.body.classList.toggle("light-mode", !state.darkMode);
    });

    document.getElementById("line-panel-close").addEventListener("click", closeLinePanel);
    document.getElementById("stop-panel-close").addEventListener("click", closeStopPanel);

    document.getElementById("hamburger-btn").addEventListener("click", () => {
        const ctrl = document.getElementById("topbar-controls");
        const btn = document.getElementById("hamburger-btn");
        const open = ctrl.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
}

// --- Init ---

async function init() {
    // Fetch backend config before initMap
    try {
        const cfg = await fetchStatus();
        if (cfg.map_center_lat && cfg.map_center_lon) {
            state.MAP_CENTER = [cfg.map_center_lat, cfg.map_center_lon];
        }
        if (cfg.map_default_zoom) state.MAP_ZOOM = cfg.map_default_zoom;
        if (cfg.nearby_radius_meters) state.nearbyRadius = cfg.nearby_radius_meters;
        if (cfg.frontend_poll_interval_ms) state.POLL_INTERVAL = cfg.frontend_poll_interval_ms;
    } catch (_) { /* use built-in defaults */ }

    initMap();

    // Map event hooks
    state.map.on("popupopen", () => startEtaCountdown());
    state.map.on("popupclose", () => { clearInterval(state.etaTimer); state.etaTimer = null; });
    state.map.on("zoomend", () => {
        Object.values(state.vehicleMarkers).forEach(m => {
            if (m._vehicleData) m.setIcon(createVehicleIcon(m._vehicleData));
        });
        updateStopBadges();
    });

    const urlParams = new URLSearchParams(location.search);
    if (urlParams.has("debug")) {
        addDriftsplatsOverlay();
    }

    const urlLat  = parseFloat(urlParams.get("lat"));
    const urlLon  = parseFloat(urlParams.get("lon"));
    const urlZoom = parseInt(urlParams.get("zoom"), 10);
    if (!isNaN(urlLat) && !isNaN(urlLon)) {
        state.map.setView([urlLat, urlLon], !isNaN(urlZoom) ? urlZoom : 17);
    }

    initControls();
    initGps();
    initFavoritesPanel();
    initDelaysPanel();
    initTrafficLayer();

    await checkStatus();
    await pollVehicles();
    await pollAlerts();

    initSSE(pollVehicles);
    setInterval(pollAlerts, 30000);
    setInterval(pollStopDepartures, 60000);

    initWeatherWidget();
    updateWeather();
    setInterval(updateWeather, 10 * 60 * 1000);

    // Pre-open line from URL param
    const preOpenLine = urlParams.get("line");
    if (preOpenLine) {
        const tryOpenLine = setInterval(() => {
            if (!state.routesLoaded) return;
            clearInterval(tryOpenLine);
            const route = Object.values(state.routeData).find(
                r => r.route_short_name === preOpenLine || r.route_id === preOpenLine
            );
            if (route) openLinePanel(route);
        }, 500);
    }

    // Retry GTFS loading
    const statusInterval = setInterval(async () => {
        await checkStatus();
        if (state.routesLoaded && state.stopsLoaded) {
            clearInterval(statusInterval);
        }
    }, 10000);
}

document.addEventListener("DOMContentLoaded", init);
