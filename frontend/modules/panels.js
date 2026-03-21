/**
 * panels.js — Panel management: stop panel, line panel, vehicle popup,
 *             ETA countdown, and panel stack handling.
 */

/* global L */

import state from "./state.js";
import { getRouteColor, getRouteTextColor, getLineStyle, applyBadgeColors } from "./colors.js";
import {
    fetchDepartures,
    fetchLineDepartures as apiFetchLineDepartures,
} from "./api.js";

// --- Panel stack management ---

export function closeAllPanels(except) {
    if (except !== "stop")      closeStopPanel();
    if (except !== "line")      closeLinePanel();
    if (except !== "nearby")    { if (window._closeNearbyPanel) window._closeNearbyPanel(); }
    if (except !== "dashboard") closeDashboardPanel();
    if (except !== "favorites") { if (window._closeFavoritesPanel) window._closeFavoritesPanel(); }
    if (except !== "delays")    closeDelaysPanel();
}

// --- Stop departure rows ---

export function buildStopDepartureRows(stop, data) {
    if (!data || !data.departures || data.departures.length === 0) return null;
    const now = Date.now() / 1000;
    return data.departures.map((d) => {
        const secs = Math.round(d.departure_time - now);
        const mins = Math.floor(secs / 60);
        const remSecs = secs % 60;
        const timeStr = secs <= 0 ? "Nu"
            : mins > 0 ? `${mins} min ${String(remSecs).padStart(2,"0")} s`
            : `${secs} s`;
        const clock = new Date(d.departure_time * 1000)
            .toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
        const custom = getLineStyle(d.route_short_name);
        const bg = custom ? `#${custom.bg}` : `#${d.route_color}`;
        const fg = custom ? `#${custom.text}` : `#${d.route_text_color}`;
        const rt = d.is_realtime
            ? '<span class="dep-rt" title="Realtid">RT</span>'
            : "";
        const delay = d.delay_minutes || 0;
        const delayHtml = d.is_realtime
            ? (delay > 0
                ? `<span class="dep-delay late" title="Försenad">+${delay}</span>`
                : delay < 0
                    ? `<span class="dep-delay early" title="Tidig">${delay}</span>`
                    : `<span class="dep-delay ontime" title="I tid">✓</span>`)
            : "";
        const tripKey = `${d.route_short_name}::${stop.stop_id}`;
        const isSaved = state.savedTrips.has(tripKey);
        const pinBtn = `<button class="save-trip-btn${isSaved ? " active" : ""}"
            data-route-id="${d.route_id}"
            data-route-short="${d.route_short_name}"
            data-route-color="${d.route_color || ''}"
            data-route-text-color="${d.route_text_color || ''}"
            data-stop-id="${stop.stop_id}"
            data-stop-name="${stop.stop_name}"
            title="${isSaved ? "Ta bort sparad resa" : "Spara resa"}">📌</button>`;
        return `
            <tr>
                <td><span class="dep-badge" data-bg="${bg}" data-fg="${fg}">${d.route_short_name}</span></td>
                <td class="dep-headsign">${d.headsign}</td>
                <td class="dep-time"><span class="dep-countdown" data-ts="${d.departure_time}">${timeStr}</span>${rt}${delayHtml}</td>
                <td class="dep-clock">${clock}</td>
                <td class="dep-pin">${pinBtn}</td>
            </tr>`;
    }).join("");
}

function bindShareBtn(btn, stop) {
    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const url = `${location.origin}/busboard.html?stop_id=${encodeURIComponent(stop.stop_id)}&stop_name=${encodeURIComponent(stop.stop_name)}`;
        try {
            await navigator.clipboard.writeText(url);
            btn.textContent = "✓";
            setTimeout(() => { btn.textContent = "🔗"; }, 1500);
        } catch {}
    });
}

export function bindStopDepartureEvents(el, stop) {
    applyBadgeColors(el);
    el.querySelectorAll(".fav-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (window._toggleFavorite) window._toggleFavorite(stop);
            btn.classList.toggle("active", state.favoriteStops.has(stop.stop_id));
            btn.title = state.favoriteStops.has(stop.stop_id) ? "Ta bort favorit" : "Spara som favorit";
        });
    });
    el.querySelectorAll(".share-btn").forEach(btn => bindShareBtn(btn, stop));
    el.querySelectorAll(".save-trip-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (window._toggleSavedTrip) {
                window._toggleSavedTrip(
                    btn.dataset.routeId, btn.dataset.routeShort,
                    btn.dataset.routeColor, btn.dataset.routeTextColor,
                    btn.dataset.stopId, btn.dataset.stopName
                );
            }
            const key = `${btn.dataset.routeShort}::${btn.dataset.stopId}`;
            btn.classList.toggle("active", state.savedTrips.has(key));
            btn.title = state.savedTrips.has(key) ? "Ta bort sparad resa" : "Spara resa";
        });
    });
}

// --- Stop departures (popup and panel) ---

export function showStopDepartures(stop, marker) {
    if (window.innerWidth <= 600) {
        openStopPanel(stop);
        fetchDepartures(stop.stop_id)
            .then(data => populateStopPanel(stop, data))
            .catch(() => populateStopPanel(stop, null));
        return;
    }

    const loadingHtml = `
        <div class="popup-stop">
            <div class="popup-stop-name">${stop.stop_name}</div>
            <div class="dep-loading">Hämtar avgångar…</div>
        </div>`;
    marker.setPopupContent(loadingHtml);

    fetchDepartures(stop.stop_id)
        .then((data) => {
            let html;
            const rows = buildStopDepartureRows(stop, data);
            if (!rows) {
                html = `
                    <div class="popup-stop">
                        <div class="popup-stop-name">${stop.stop_name}</div>
                        <div class="dep-empty">Inga kommande avgångar</div>
                    </div>`;
            } else {
                const platformChip = stop.platform_code
                    ? `<span class="popup-platform">Läge ${stop.platform_code}</span>`
                    : "";
                const isFav = state.favoriteStops.has(stop.stop_id);
                const favBtn = `<button class="fav-btn${isFav ? " active" : ""}" data-stop-id="${stop.stop_id}" title="${isFav ? "Ta bort favorit" : "Spara som favorit"}">★</button>`;
                const shareBtn = `<button class="share-btn" title="Kopiera länk">🔗</button>`;
                html = `
                    <div class="popup-stop">
                        <div class="popup-stop-name">${stop.stop_name}${platformChip}
                            ${favBtn}${shareBtn}
                            <a class="board-link" href="/busboard.html?stop_id=${encodeURIComponent(stop.stop_id)}&stop_name=${encodeURIComponent(stop.stop_name)}" target="_blank" title="Öppna avgångstavla">&#128507;</a>
                        </div>
                        <table class="dep-table"><tbody>${rows}</tbody></table>
                    </div>`;
            }
            if (marker.isPopupOpen()) {
                marker.setPopupContent(html);
                const popup = marker.getPopup();
                if (popup) {
                    const el = popup.getElement();
                    if (el) bindStopDepartureEvents(el, stop);
                }
            }
        })
        .catch(() => {
            if (marker.isPopupOpen()) {
                marker.setPopupContent(`
                    <div class="popup-stop">
                        <div class="popup-stop-name">${stop.stop_name}</div>
                        <div class="dep-empty">Kunde inte hämta avgångar</div>
                    </div>`);
            }
        });
}

// --- Stop panel (mobile) ---

export function openStopPanel(stop) {
    closeAllPanels("stop");
    const panel = document.getElementById("stop-panel");
    const title = document.getElementById("stop-panel-title");
    const actions = document.getElementById("stop-panel-actions");
    const body = document.getElementById("stop-panel-body");
    const platformChip = stop.platform_code
        ? ` <span class="popup-platform">Läge ${stop.platform_code}</span>`
        : "";
    title.innerHTML = `${stop.stop_name}${platformChip}`;
    const isFav = state.favoriteStops.has(stop.stop_id);
    actions.innerHTML = `
        <button class="fav-btn${isFav ? " active" : ""}" data-stop-id="${stop.stop_id}" title="${isFav ? "Ta bort favorit" : "Spara som favorit"}">★</button>
        <button class="share-btn" title="Kopiera länk">🔗</button>
        <a class="board-link" href="/busboard.html?stop_id=${encodeURIComponent(stop.stop_id)}&stop_name=${encodeURIComponent(stop.stop_name)}" target="_blank" title="Öppna avgångstavla">&#128507;</a>`;
    body.innerHTML = `<div class="dep-loading" style="padding:14px">Hämtar avgångar…</div>`;
    actions.querySelectorAll(".fav-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (window._toggleFavorite) window._toggleFavorite(stop);
            btn.classList.toggle("active", state.favoriteStops.has(stop.stop_id));
            btn.title = state.favoriteStops.has(stop.stop_id) ? "Ta bort favorit" : "Spara som favorit";
        });
    });
    actions.querySelectorAll(".share-btn").forEach(btn => bindShareBtn(btn, stop));
    panel.classList.add("open");
    document.body.classList.add("stop-open");
    setTimeout(() => state.map.invalidateSize(), 310);
}

export function closeStopPanel() {
    document.getElementById("stop-panel").classList.remove("open");
    document.body.classList.remove("stop-open");
    setTimeout(() => state.map.invalidateSize(), 310);
}

export function populateStopPanel(stop, data) {
    const body = document.getElementById("stop-panel-body");
    if (!document.getElementById("stop-panel").classList.contains("open")) return;
    const rows = buildStopDepartureRows(stop, data);
    if (!rows) {
        body.innerHTML = `<div class="dep-empty" style="padding:14px">Inga kommande avgångar</div>`;
        return;
    }
    body.innerHTML = `<table class="dep-table" style="width:100%;padding:0 14px;box-sizing:border-box"><tbody>${rows}</tbody></table>`;
    bindStopDepartureEvents(body, stop);
}

// --- ETA countdown ---

export function startEtaCountdown() {
    clearInterval(state.etaTimer);
    state.etaTimer = setInterval(() => {
        const now = Date.now() / 1000;
        document.querySelectorAll(".dep-countdown").forEach(el => {
            const ts = parseFloat(el.dataset.ts);
            const secs = Math.round(ts - now);
            if (secs <= 0) { el.textContent = "Nu"; return; }
            const m = Math.floor(secs / 60);
            const s = secs % 60;
            el.textContent = m > 0 ? `${m} min ${String(s).padStart(2,"0")} s` : `${secs} s`;
        });
    }, 1000);
}

// --- Vehicle popup ---

export function showVehiclePopup(vehicle, marker) {
    const color = getRouteColor({
        route_color: vehicle.route_color,
        route_short_name: vehicle.route_short_name,
        route_id: vehicle.route_id,
    });

    const lineName = vehicle.route_short_name || "?";
    let headsign = vehicle.trip_headsign || "";
    const isTrain = vehicle.vehicle_type === "train";
    const typeLabel = isTrain ? "Tåg" : "Buss";
    const isRouteName = headsign.includes(" - ");
    let title;
    if (headsign && !isRouteName) {
        title = `${typeLabel} ${lineName} mot ${headsign}`;
    } else if (headsign && isRouteName) {
        title = `${typeLabel} ${lineName} ${headsign}`;
    } else {
        title = `${typeLabel} ${lineName}`;
    }

    const speedMs = vehicle.speed != null ? vehicle.speed : vehicle._calculatedSpeed;
    const speed = speedMs != null
        ? `${(speedMs * 3.6).toFixed(0)} km/h`
        : null;
    const status = vehicle.current_status || "I trafik";
    const updatedAt = vehicle.timestamp
        ? new Date(vehicle.timestamp * 1000).toLocaleTimeString("sv-SE")
        : new Date().toLocaleTimeString("sv-SE");

    const nextStop = vehicle.next_stop_name || "";
    const nextStopPlatform = vehicle.next_stop_platform || "";
    const nextStopLabel = vehicle.current_status === "Vid hållplats"
        ? "Vid hållplats"
        : "Nästa hållplats";
    const platformChip = nextStopPlatform
        ? ` <span class="popup-platform">Läge ${nextStopPlatform}</span>`
        : "";

    let delayHtml = "";
    if (!isTrain && vehicle.delay_seconds != null) {
        const delayMin = Math.round(vehicle.delay_seconds / 60);
        if (vehicle.delay_seconds > 60) {
            const nextStopPart = nextStop ? ` till ${nextStop}` : "";
            delayHtml = `<span class="popup-delay popup-delay--late">${delayMin} min försenad${nextStopPart}</span><br/>`;
        } else if (vehicle.delay_seconds < -60) {
            delayHtml = `<span class="popup-delay popup-delay--early">${Math.abs(delayMin)} min tidig</span><br/>`;
        } else {
            delayHtml = `<span class="popup-delay popup-delay--ontime">I tid</span><br/>`;
        }
    }

    const custom = getLineStyle(lineName);
    const badgeBg = custom ? `#${custom.bg}` : (vehicle.route_color ? `#${vehicle.route_color}` : color);
    const badgeFg = custom ? `#${custom.text}` : (vehicle.route_text_color ? `#${vehicle.route_text_color}` : "#fff");
    const vehicleIdStr = vehicle.vehicle_id
        ? `Fordon #${String(vehicle.vehicle_id).split(":").pop()}<br/>`
        : "";
    const hasRoute = vehicle.route_id && state.routeData[vehicle.route_id];

    const html = `
        <div class="popup-vehicle">
            <div style="margin-bottom:4px">
                <span class="popup-veh-badge" style="background:${badgeBg};color:${badgeFg}">${lineName}</span>
            </div>
            <div class="popup-title" data-color="${color}">${title}</div>
            <div class="popup-details">
                ${delayHtml}
                ${nextStop ? `${nextStopLabel}: <strong>${nextStop}</strong>${platformChip}<br/>` : ""}
                ${speed ? `Hastighet: ${speed}<br/>` : ""}
                ${vehicleIdStr}
                Uppdaterad: ${updatedAt}
            </div>
            ${hasRoute ? `<button class="popup-open-line-btn" data-route-id="${vehicle.route_id}">Visa linje →</button>` : ""}
        </div>
    `;
    const popup = L.popup({ maxWidth: 260 })
        .setLatLng(marker.getLatLng())
        .setContent(html)
        .openOn(state.map);
    requestAnimationFrame(() => {
        const el = popup.getElement();
        if (!el) return;
        el.querySelectorAll("[data-color]").forEach(e => { e.style.color = e.dataset.color; });
        el.querySelectorAll(".popup-open-line-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                state.map.closePopup();
                const route = state.routeData[btn.dataset.routeId];
                if (route) openLinePanel(route);
            });
        });
    });
}

// --- Line panel ---

export function openLinePanel(route) {
    closeAllPanels("line");
    state.activePanelRouteId = route.route_id;

    const color = getRouteColor(route);
    const textColor = getRouteTextColor(route);
    const titleEl = document.getElementById("line-panel-title");
    titleEl.innerHTML =
        `<span class="dep-badge" data-bg="${color}" data-fg="${textColor}">${route.route_short_name}</span>` +
        `<span class="lp-route-name">${route.route_long_name || ""}</span>`;
    applyBadgeColors(titleEl);
    document.getElementById("line-panel-content").innerHTML =
        `<div class="lp-loading">Hämtar avgångar…</div>`;
    document.getElementById("line-panel").classList.add("open");
    document.body.classList.add("panel-open");

    document.querySelectorAll(".line-btn").forEach(b => b.classList.remove("panel-active"));
    document.querySelectorAll(".line-btn").forEach(b => {
        if (b.textContent.trim() === (route.route_short_name || route.route_id)) {
            b.classList.add("panel-active");
        }
    });

    state.map.invalidateSize();
    fetchLineDepartures(route.route_id);

    clearInterval(state.linePanelTimer);
    state.linePanelTimer = setInterval(() => {
        if (state.activePanelRouteId) fetchLineDepartures(state.activePanelRouteId);
    }, 30000);
}

export function closeLinePanel() {
    state.activePanelRouteId = null;
    state.activeFilters.clear();
    if (window._renderFilterChips) window._renderFilterChips();
    document.getElementById("line-panel").classList.remove("open");
    document.body.classList.remove("panel-open");
    document.querySelectorAll(".line-btn").forEach(b => {
        b.classList.remove("panel-active");
        b.classList.remove("inactive");
    });
    clearInterval(state.linePanelTimer);
    state.map.invalidateSize();
    setTimeout(() => state.map.invalidateSize(), 310);
}

function fetchLineDepartures(routeId) {
    apiFetchLineDepartures(routeId)
        .then(data => {
            if (state.activePanelRouteId !== routeId) return;
            const content = document.getElementById("line-panel-content");
            if (!data.directions || data.directions.length === 0) {
                content.innerHTML = `<div class="lp-empty">Inga kommande avgångar</div>`;
                return;
            }

            const now = Date.now() / 1000;
            content.innerHTML = data.directions.map(dir => {
                const rows = (dir.stops || []).map(s => {
                    const dt = new Date(s.time * 1000);
                    const clock = dt.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
                    const min = Math.max(0, Math.round((s.time - now) / 60));
                    const minStr = min === 0 ? "Nu" : `${min} min`;
                    const minClass = min <= 2 ? "lp-min soon" : "lp-min";
                    const rt = s.is_realtime ? `<span class="lp-rt">RT</span>` : "";
                    return `<div class="lp-dep">
                        <span class="lp-stop">${s.stop_name}</span>
                        <span class="lp-time">${clock}</span>
                        <span class="${minClass}">${minStr}</span>
                        ${rt}
                    </div>`;
                }).join("");
                return `<div class="lp-section">
                    <div class="lp-section-header">mot ${dir.headsign}</div>
                    ${rows}
                </div>`;
            }).join("");
        })
        .catch(() => {
            if (state.activePanelRouteId !== routeId) return;
            document.getElementById("line-panel-content").innerHTML =
                `<div class="lp-empty">Kunde inte hämta avgångar</div>`;
        });
}

// --- Dashboard panel ---

export function openDashboardPanel() {
    closeAllPanels("dashboard");
    if (window._updateDashboardAlerts) window._updateDashboardAlerts(state._dashAlerts);
    if (window._renderDashboardFavorites) window._renderDashboardFavorites();
    document.getElementById("dashboard-panel").classList.add("open");
}

export function closeDashboardPanel() {
    document.getElementById("dashboard-panel").classList.remove("open");
}

// --- Delays panel ---

export function closeDelaysPanel() {
    document.getElementById("delays-overlay").classList.remove("open");
}
