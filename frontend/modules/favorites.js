/**
 * favorites.js — Favorite stops, saved trips, and favorites panel.
 */

import state from "./state.js";
import { getLineStyle } from "./colors.js";
import { fetchDepartures } from "./api.js";
import { closeAllPanels } from "./panels.js";

// --- Persistence ---

function saveFavorites() {
    localStorage.setItem("favoriteStops", JSON.stringify([...state.favoriteStops.values()]));
}

function saveSavedTrips() {
    localStorage.setItem("savedTrips", JSON.stringify([...state.savedTrips.values()]));
}

// --- Toggle ---

export function toggleFavorite(stop) {
    if (state.favoriteStops.has(stop.stop_id)) {
        state.favoriteStops.delete(stop.stop_id);
    } else {
        state.favoriteStops.set(stop.stop_id, { stop_id: stop.stop_id, stop_name: stop.stop_name });
    }
    saveFavorites();
    renderFavoritesPanel();
}

export function toggleSavedTrip(route_id, route_short_name, route_color, route_text_color, stop_id, stop_name) {
    const key = `${route_short_name}::${stop_id}`;
    if (state.savedTrips.has(key)) {
        state.savedTrips.delete(key);
    } else {
        state.savedTrips.set(key, { route_id, route_short_name, route_color, route_text_color, stop_id, stop_name });
    }
    saveSavedTrips();
    renderFavoritesPanel();
}

// --- Panel rendering ---

export function renderFavoritesPanel() {
    const panel = document.getElementById("favorites-panel");
    const body = document.getElementById("favorites-panel-body");
    if (!panel || !body) return;

    let html = "";

    // Stops section
    html += `<div class="fav-section">`;
    html += `<div class="fav-section-title">★ Hållplatser</div>`;
    if (state.favoriteStops.size === 0) {
        html += `<div class="fav-empty">Inga favorithållplatser ännu.<br>Klicka på ★ i en hållplats-popup för att spara.</div>`;
    } else {
        html += [...state.favoriteStops.values()].map(s => `
            <div class="fav-stop" data-stop-id="${s.stop_id}">
                <span class="fav-stop-name">${s.stop_name}</span>
                <div class="fav-stop-deps" id="fav-deps-${s.stop_id}">
                    <span class="fav-loading">Hämtar…</span>
                </div>
            </div>`).join("");
    }
    html += `</div>`;

    // Saved trips section
    html += `<div class="fav-section">`;
    html += `<div class="fav-section-title">📌 Mina resor</div>`;
    if (state.savedTrips.size === 0) {
        html += `<div class="fav-empty">Inga sparade resor ännu.<br>Klicka på 📌 vid en avgång för att spara.</div>`;
    } else {
        html += [...state.savedTrips.entries()].map(([key, t]) => {
            const custom = getLineStyle(t.route_short_name);
            const bg = custom ? `#${custom.bg}` : (t.route_color ? `#${t.route_color}` : "#555");
            const fg = custom ? `#${custom.text}` : (t.route_text_color ? `#${t.route_text_color}` : "#fff");
            const safeKey = key.replace(/::/g, "-");
            return `
            <div class="saved-trip-card" data-key="${key}">
                <span class="fav-dep-badge" style="background:${bg};color:${fg};flex-shrink:0">${t.route_short_name}</span>
                <div class="saved-trip-info">
                    <div class="saved-trip-label">från ${t.stop_name}</div>
                    <div class="fav-stop-deps" id="trip-deps-${safeKey}"><span class="fav-loading">Hämtar…</span></div>
                </div>
                <button class="saved-trip-remove" data-key="${key}" title="Ta bort">✕</button>
            </div>`;
        }).join("");
    }
    html += `</div>`;

    body.innerHTML = html;

    // Bind remove-trip buttons
    body.querySelectorAll(".saved-trip-remove").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            state.savedTrips.delete(btn.dataset.key);
            saveSavedTrips();
            renderFavoritesPanel();
        });
    });

    fetchFavoriteDepartures();
    fetchSavedTripDepartures();
}

function fetchFavoriteDepartures() {
    state.favoriteStops.forEach(s => {
        fetchDepartures(s.stop_id, 3).then(data => {
            const el = document.getElementById(`fav-deps-${s.stop_id}`);
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
        }).catch(() => {
            const el = document.getElementById(`fav-deps-${s.stop_id}`);
            if (el) el.innerHTML = `<span class="fav-empty-deps">Fel</span>`;
        });
    });
}

function fetchSavedTripDepartures() {
    state.savedTrips.forEach((trip, key) => {
        const safeKey = key.replace(/::/g, "-");
        fetchDepartures(trip.stop_id, 8).then(data => {
            const el = document.getElementById(`trip-deps-${safeKey}`);
            if (!el) return;
            const filtered = (data.departures || []).filter(d => d.route_short_name === trip.route_short_name);
            if (filtered.length === 0) {
                el.innerHTML = `<span class="fav-empty-deps">Inga avgångar</span>`;
                return;
            }
            const now = Date.now() / 1000;
            el.innerHTML = filtered.slice(0, 3).map(d => {
                const mins = Math.max(0, Math.round((d.departure_time - now) / 60));
                const timeStr = mins === 0 ? "Nu" : `${mins} min`;
                return `<span class="fav-dep">
                    <span class="fav-dep-headsign">${d.headsign}</span>
                    <span class="fav-dep-time">${timeStr}</span>
                </span>`;
            }).join("");
        }).catch(() => {
            const el = document.getElementById(`trip-deps-${safeKey}`);
            if (el) el.innerHTML = `<span class="fav-empty-deps">Fel</span>`;
        });
    });
}

// --- Panel open/close ---

export function openFavoritesPanel() {
    closeAllPanels("favorites");
    renderFavoritesPanel();
    document.getElementById("favorites-panel").classList.add("open");
    clearInterval(state.favoritesTimer);
    state.favoritesTimer = setInterval(() => { fetchFavoriteDepartures(); fetchSavedTripDepartures(); }, 15000);
}

export function closeFavoritesPanel() {
    document.getElementById("favorites-panel").classList.remove("open");
    clearInterval(state.favoritesTimer);
    state.favoritesTimer = null;
}

export function initFavoritesPanel() {
    const btn = document.getElementById("fav-panel-btn");
    if (btn) btn.addEventListener("click", openFavoritesPanel);
    const closeBtn = document.getElementById("favorites-panel-close");
    if (closeBtn) closeBtn.addEventListener("click", closeFavoritesPanel);
}
