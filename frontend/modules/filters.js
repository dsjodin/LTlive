/**
 * filters.js — Line filter buttons, filter chips, and vehicle type filter buttons.
 */

import state from "./state.js";
import { getRouteColor, getRouteTextColor, applyBadgeColors } from "./colors.js";
import { openLinePanel, closeLinePanel, openDashboardPanel, closeDashboardPanel } from "./panels.js";
import { toggleRouteShapes } from "./stops.js";

// --- Line filter buttons ---

export function buildLineButtons(routes) {
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
            if (state.activeFilters.has(route.route_id)) {
                state.activeFilters.delete(route.route_id);
                btn.classList.remove("inactive");
            } else if (state.activeFilters.size === 0) {
                state.activeFilters.clear();
                state.activeFilters.add(route.route_id);
                document.querySelectorAll(".line-btn").forEach((b) =>
                    b.classList.add("inactive")
                );
                btn.classList.remove("inactive");
            } else {
                state.activeFilters.add(route.route_id);
                btn.classList.remove("inactive");
            }

            if (state.activeFilters.size >= sorted.length) {
                state.activeFilters.clear();
                document.querySelectorAll(".line-btn").forEach((b) =>
                    b.classList.remove("inactive")
                );
            }

            renderFilterChips();

            if (state.showRoutes) {
                Object.values(state.routeLayers).forEach((l) => state.map.removeLayer(l));
                toggleRouteShapes(true);
            }

            if (state.activePanelRouteId === route.route_id) {
                closeLinePanel();
            } else {
                openLinePanel(route);
            }
        });

        container.appendChild(btn);
    });
}

// --- Active filter chips ---

export function renderFilterChips() {
    const container = document.getElementById("filter-chips");
    if (!container) return;
    if (state.activeFilters.size === 0) {
        container.innerHTML = "";
        container.classList.remove("visible");
        return;
    }
    let html = "";
    state.activeFilters.forEach(routeId => {
        const route = state.routeData[routeId];
        if (!route) return;
        const color = getRouteColor(route);
        const textColor = getRouteTextColor(route);
        const name = route.route_short_name || routeId;
        html += `<button class="filter-chip" data-route-id="${routeId}" data-bg="${color}" data-fg="${textColor}">${name} ✕</button>`;
    });
    html += `<button class="filter-chip filter-chip-clear">Rensa alla</button>`;
    container.innerHTML = html;
    applyBadgeColors(container);
    container.classList.add("visible");

    container.querySelectorAll(".filter-chip[data-route-id]").forEach(btn => {
        btn.addEventListener("click", () => {
            state.activeFilters.delete(btn.dataset.routeId);
            document.querySelectorAll(".line-btn").forEach(b => {
                if (state.activeFilters.size === 0) b.classList.remove("inactive");
            });
            renderFilterChips();
            if (state.showRoutes) {
                Object.values(state.routeLayers).forEach(l => state.map.removeLayer(l));
                toggleRouteShapes(true);
            }
        });
    });
    container.querySelector(".filter-chip-clear")?.addEventListener("click", () => {
        state.activeFilters.clear();
        document.querySelectorAll(".line-btn").forEach(b => {
            b.classList.remove("inactive");
            b.classList.remove("panel-active");
        });
        renderFilterChips();
        if (state.showRoutes) {
            Object.values(state.routeLayers).forEach(l => state.map.removeLayer(l));
            toggleRouteShapes(true);
        }
    });
}

// --- Vehicle type filter buttons ---

export function initTypeFilterButtons() {
    const types = [
        { type: "bus",   label: "Bussar" },
        { type: "train", label: "Tåg" },
    ];
    types.forEach(({ type }) => {
        const btn = document.getElementById(`type-btn-${type}`);
        if (!btn) return;
        btn.addEventListener("click", () => {
            if (state.hiddenTypes.has(type)) {
                state.hiddenTypes.delete(type);
                btn.classList.remove("inactive");
            } else {
                state.hiddenTypes.add(type);
                btn.classList.add("inactive");
            }
        });
    });

    const dashBtn = document.getElementById("dashboard-btn");
    if (dashBtn) dashBtn.addEventListener("click", openDashboardPanel);
    const dashClose = document.getElementById("dashboard-panel-close");
    if (dashClose) dashClose.addEventListener("click", closeDashboardPanel);
}
