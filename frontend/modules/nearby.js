/**
 * nearby.js — GPS location tracking and nearby departures panel.
 */

/* global L */

import state from "./state.js";
import { getLineStyle, applyBadgeColors } from "./colors.js";
import { fetchNearbyDepartures as apiFetchNearbyDepartures } from "./api.js";
import { closeAllPanels } from "./panels.js";

// --- GPS ---

export function initGps() {
    document.getElementById("gps-btn").addEventListener("click", toggleGps);
    document.getElementById("nearby-panel-close").addEventListener("click", closeNearbyPanel);
}

function toggleGps() {
    if (state.nearbyPanelOpen) {
        closeNearbyPanel();
        return;
    }
    if (!navigator.geolocation) {
        alert("Din enhet stödjer inte GPS-positionering.");
        return;
    }
    const btn = document.getElementById("gps-btn");
    btn.classList.add("locating");
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            btn.classList.remove("locating");
            btn.classList.add("active");
            onPosition(pos);
            openNearbyPanel();
            if (state.geoWatchId !== null) navigator.geolocation.clearWatch(state.geoWatchId);
            state.geoWatchId = navigator.geolocation.watchPosition(onPosition, null, {
                enableHighAccuracy: true, maximumAge: 10000,
            });
        },
        () => {
            btn.classList.remove("locating");
            alert("Kunde inte hämta din position. Kontrollera att platsåtkomst är tillåten.");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function onPosition(pos) {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    const latlng = [lat, lon];

    if (!state.userMarker) {
        state.userMarker = L.marker(latlng, {
            icon: L.divIcon({
                className: "",
                html: `<div class="user-location-dot"><div class="user-location-pulse"></div></div>`,
                iconSize: [16, 16],
                iconAnchor: [8, 8],
            }),
            zIndexOffset: 2000,
        }).addTo(state.map);
    } else {
        state.userMarker.setLatLng(latlng);
    }

    if (!state.userAccCircle) {
        state.userAccCircle = L.circle(latlng, {
            radius: accuracy,
            color: "#3b82f6",
            fillColor: "#3b82f6",
            fillOpacity: 0.08,
            weight: 1,
            opacity: 0.4,
        }).addTo(state.map);
    } else {
        state.userAccCircle.setLatLng(latlng).setRadius(accuracy);
    }

    if (!state.lastNearbyPos) {
        state.map.setView(latlng, 16);
    }

    const moved = state.lastNearbyPos
        ? state.map.distance(state.lastNearbyPos, latlng)
        : Infinity;
    state.lastNearbyPos = latlng;
    if (moved > 30 && state.nearbyPanelOpen) {
        fetchNearbyDepartures(lat, lon);
    }
}

function openNearbyPanel() {
    closeAllPanels("nearby");
    state.nearbyPanelOpen = true;
    document.getElementById("nearby-panel").classList.add("open");
    document.body.classList.add("nearby-open");
    state.map.invalidateSize();
    setTimeout(() => {
        state.map.invalidateSize();
        if (state.lastNearbyPos) state.map.panTo(state.lastNearbyPos);
    }, 320);
    if (state.lastNearbyPos) {
        fetchNearbyDepartures(state.lastNearbyPos[0], state.lastNearbyPos[1]);
    }
    clearInterval(state.nearbyTimer);
    state.nearbyTimer = setInterval(() => {
        if (state.nearbyPanelOpen && state.lastNearbyPos) {
            fetchNearbyDepartures(state.lastNearbyPos[0], state.lastNearbyPos[1]);
        }
    }, 30000);
}

export function closeNearbyPanel() {
    state.nearbyPanelOpen = false;
    document.getElementById("nearby-panel").classList.remove("open");
    document.body.classList.remove("nearby-open");
    document.getElementById("gps-btn").classList.remove("active");
    clearInterval(state.nearbyTimer);
    if (state.geoWatchId !== null) {
        navigator.geolocation.clearWatch(state.geoWatchId);
        state.geoWatchId = null;
    }
    if (state.userMarker) { state.map.removeLayer(state.userMarker); state.userMarker = null; }
    if (state.userAccCircle) { state.map.removeLayer(state.userAccCircle); state.userAccCircle = null; }
    state.lastNearbyPos = null;
    state.map.invalidateSize();
}

function fetchNearbyDepartures(lat, lon) {
    const body = document.getElementById("nearby-panel-body");
    if (!body.hasChildNodes()) {
        body.innerHTML = `<div class="nearby-loading">Söker hållplatser…</div>`;
    }
    apiFetchNearbyDepartures(lat, lon, state.nearbyRadius)
        .then(data => {
            if (!state.nearbyPanelOpen) return;
            if (!data.stops || data.stops.length === 0) {
                body.innerHTML = `<div class="nearby-empty">Inga hållplatser inom ${state.nearbyRadius} m</div>`;
                return;
            }
            const now = Date.now() / 1000;
            body.innerHTML = data.stops.map(stop => {
                const distStr = stop.distance_m < 1000
                    ? `${stop.distance_m} m`
                    : `${(stop.distance_m / 1000).toFixed(1)} km`;
                const deps = stop.departures.map(d => {
                    const custom = getLineStyle(d.route_short_name);
                    const bg = custom ? `#${custom.bg}` : `#${d.route_color}`;
                    const fg = custom ? `#${custom.text}` : `#${d.route_text_color}`;
                    const min = Math.max(0, Math.round((d.departure_time - now) / 60));
                    const minStr = min === 0 ? "Nu" : `${min} min`;
                    const minClass = min <= 2 ? "nearby-min soon" : "nearby-min";
                    const rt = d.is_realtime ? `<span class="lp-rt">RT</span>` : "";
                    return `<div class="nearby-dep">
                        <span class="dep-badge" data-bg="${bg}" data-fg="${fg}">${d.route_short_name}</span>
                        <span class="nearby-headsign">${d.headsign}</span>
                        <span class="${minClass}">${minStr}</span>
                        ${rt}
                    </div>`;
                }).join("") || `<div class="nearby-nodep">Inga avgångar</div>`;
                const platformLabel = stop.platform_code
                    ? `<span class="nearby-platform">Läge ${stop.platform_code}</span>`
                    : stop.stop_desc
                        ? `<span class="nearby-platform">${stop.stop_desc}</span>`
                        : "";
                return `<div class="nearby-stop">
                    <div class="nearby-stop-header">
                        <span class="nearby-stop-name">${stop.stop_name}${platformLabel}</span>
                        <span class="nearby-dist">${distStr}</span>
                    </div>
                    ${deps}
                </div>`;
            }).join("");
            applyBadgeColors(body);
        })
        .catch(() => {
            if (!state.nearbyPanelOpen) return;
            document.getElementById("nearby-panel-body").innerHTML =
                `<div class="nearby-empty">Kunde inte hämta avgångar</div>`;
        });
}
