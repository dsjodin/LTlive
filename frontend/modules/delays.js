/**
 * delays.js — Delays overlay panel showing late vehicles.
 */

import state from "./state.js";
import { getRouteColor, getRouteTextColor } from "./colors.js";
import { closeAllPanels } from "./panels.js";

export function buildDelaysTable() {
    const buses = Object.values(state.vehicleMarkers)
        .map(m => m._vehicleData)
        .filter(v => v && v.vehicle_type !== "train" && v.delay_seconds != null && v.delay_seconds > 60);

    buses.sort((a, b) => b.delay_seconds - a.delay_seconds);
    const top = buses.slice(0, 20);

    const tbody = document.getElementById("delays-tbody");
    const empty = document.getElementById("delays-empty");
    const table = document.getElementById("delays-table");

    if (top.length === 0) {
        table.style.display = "none";
        empty.style.display = "";
        return;
    }
    table.style.display = "";
    empty.style.display = "none";

    tbody.innerHTML = top.map(v => {
        const delayMin = Math.round(v.delay_seconds / 60);
        const delayClass = v.delay_seconds > 300 ? "delays-delay--critical" : "delays-delay--warning";
        const line = v.route_short_name || "?";
        const dest = v.trip_headsign || "—";
        const stop = v.next_stop_name || "—";
        return `<tr data-vehicle-id="${v.vehicle_id || v.id}">
            <td><span class="delays-line-chip" style="background:#${v.route_color||'0074D9'};color:#${v.route_text_color||'FFFFFF'}">${line}</span></td>
            <td>${dest}</td>
            <td class="delays-delay-cell ${delayClass}">+${delayMin} min</td>
            <td>${stop}</td>
        </tr>`;
    }).join("");

    tbody.querySelectorAll("tr[data-vehicle-id]").forEach(row => {
        row.addEventListener("click", () => {
            const vid = row.dataset.vehicleId;
            closeDelaysPanel();
            const marker = state.vehicleMarkers[vid];
            if (marker) {
                state.map.setView(marker.getLatLng(), Math.max(state.map.getZoom(), 15));
                marker.fire("click");
            }
        });
    });
}

export function openDelaysPanel() {
    closeAllPanels("delays");
    buildDelaysTable();
    document.getElementById("delays-overlay").classList.add("open");
}

export function closeDelaysPanel() {
    document.getElementById("delays-overlay").classList.remove("open");
}

export function initDelaysPanel() {
    document.getElementById("delays-btn").addEventListener("click", openDelaysPanel);
    document.getElementById("delays-panel-close").addEventListener("click", closeDelaysPanel);
    document.getElementById("delays-overlay").addEventListener("click", e => {
        if (e.target === document.getElementById("delays-overlay")) closeDelaysPanel();
    });
}
