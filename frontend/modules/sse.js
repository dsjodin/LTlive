/**
 * sse.js — SSE connection management and status indicator.
 */

import state from "./state.js";
import { connectSSE } from "./api.js";
import { updateVehicles } from "./vehicles.js";
import { updateAlerts, updateDashboard } from "./dashboard.js";
import { renderTrafficLayer } from "./traffic.js";

const vehicleOpts = { onDashboardUpdate: updateDashboard };

// --- SSE status indicator ---

export function setSseStatus(sseState) {
    const el = document.getElementById("sse-status");
    if (!el) return;
    const text = el.querySelector(".sse-text");
    el.className = "sse-status sse-" + sseState;
    if (sseState === "live") {
        text.textContent = "Live";
    } else if (sseState === "polling") {
        text.textContent = `Polling ${Math.round(state.POLL_INTERVAL / 1000)}s`;
    } else if (sseState === "error") {
        text.textContent = "Offline";
    } else {
        text.textContent = "Ansluter";
    }
}

// --- SSE connection ---

export function initSSE(pollVehiclesFn) {
    if (state.sseSource) {
        state.sseSource.close();
        state.sseSource = null;
    }
    state._deltaReady = false;

    function cancelFallback() {
        if (state.sseFallbackTimer) { clearInterval(state.sseFallbackTimer); state.sseFallbackTimer = null; }
    }

    setSseStatus("connecting");

    state.sseSource = connectSSE(
        // onVehicles — full list
        (data) => {
            cancelFallback();
            setSseStatus("live");
            state._vehicleState.clear();
            (data.vehicles || []).forEach(v => { if (v.vehicle_id) state._vehicleState.set(v.vehicle_id, v); });
            updateVehicles(data.vehicles, vehicleOpts);
            state._deltaReady = true;
        },
        // onAlerts
        (data) => updateAlerts(data.alerts),
        // onError
        () => {
            if (!state.sseFallbackTimer) {
                console.warn("SSE unavailable, falling back to polling");
                setSseStatus("polling");
                state.sseFallbackTimer = setInterval(pollVehiclesFn, state.POLL_INTERVAL);
            }
        },
        // onOpen
        () => {
            cancelFallback();
            setSseStatus("live");
            state._deltaReady = false;
        },
        // onVehiclesDelta
        (data) => {
            if (!state._deltaReady) return;
            cancelFallback();
            (data.updated || []).forEach(v => { if (v.vehicle_id) state._vehicleState.set(v.vehicle_id, v); });
            (data.removed || []).forEach(id => state._vehicleState.delete(id));
            updateVehicles(Array.from(state._vehicleState.values()), vehicleOpts);
        },
        // onTraffic
        (data) => {
            if (state.showTraffic) renderTrafficLayer(data);
        },
    );
}
