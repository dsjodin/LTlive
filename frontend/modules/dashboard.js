/**
 * dashboard.js — Dashboard panel: vehicle counts, alerts, and favorites.
 */

/* global ALLOWED_LINE_NUMBERS */

import state from "./state.js";
import { getLineStyle } from "./colors.js";
import { fetchDepartures } from "./api.js";

// --- Vehicle counts ---

export function updateDashboard(vehicles) {
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

// --- Alerts ---

export function filterAlertsForDisplayedLines(alerts) {
    if (ALLOWED_LINE_NUMBERS.size === 0) return alerts;
    return alerts.filter(a => {
        if (!a.affected_routes || a.affected_routes.length === 0) return false;
        return a.affected_routes.some(routeId => {
            const route = state.routeData[routeId];
            return route && ALLOWED_LINE_NUMBERS.has(route.route_short_name);
        });
    });
}

export function updateDashboardAlerts(alerts) {
    state._dashAlerts = alerts;
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

export function updateAlerts(alerts) {
    const filtered = filterAlertsForDisplayedLines(alerts);
    updateDashboardAlerts(filtered);
}

// --- Dashboard favorites ---

export function renderDashboardFavorites() {
    const section = document.getElementById("dash-favorites-body");
    if (!section) return;
    if (state.favoriteStops.size === 0) {
        section.innerHTML = `<div class="dash-no-fav">Inga favorithållplatser. Klicka ★ i en hållplats-popup.</div>`;
        return;
    }
    section.innerHTML = [...state.favoriteStops.values()].map(s => `
        <div class="dash-fav-stop" data-stop-id="${s.stop_id}">
            <span class="dash-fav-name">${s.stop_name}</span>
            <div class="dash-fav-deps" id="dashdeps-${s.stop_id}"><span class="fav-loading">Hämtar…</span></div>
        </div>`).join("");
    state.favoriteStops.forEach(s => {
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
