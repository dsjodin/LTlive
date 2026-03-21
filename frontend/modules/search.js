/**
 * search.js — Mobile stop search with autocomplete.
 */

import state from "./state.js";

let searchInput, resultsEl;
let debounceTimer = null;

export function initSearch() {
    searchInput = document.getElementById("mobile-search-input");
    resultsEl = document.getElementById("mobile-search-results");
    if (!searchInput || !resultsEl) return;

    searchInput.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(doSearch, 200);
    });

    searchInput.addEventListener("focus", () => {
        if (searchInput.value.length >= 2) doSearch();
    });

    // Close on outside tap
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".mobile-search")) {
            resultsEl.classList.remove("visible");
        }
    });
}

function doSearch() {
    const q = (searchInput.value || "").trim().toLowerCase();
    if (q.length < 2) {
        resultsEl.classList.remove("visible");
        resultsEl.innerHTML = "";
        return;
    }

    // Search through loaded stops
    const stops = [];
    if (state.stopMarkerMap) {
        for (const [id, marker] of Object.entries(state.stopMarkerMap)) {
            const stop = marker._stopData || marker.options?._stopData;
            if (!stop) continue;
            const name = (stop.stop_name || "").toLowerCase();
            if (name.includes(q)) {
                stops.push(stop);
                if (stops.length >= 8) break;
            }
        }
    }

    if (stops.length === 0) {
        resultsEl.innerHTML = `<div class="search-result-empty">Inga hållplatser hittades</div>`;
        resultsEl.classList.add("visible");
        return;
    }

    resultsEl.innerHTML = stops.map(s =>
        `<div class="search-result-item" data-stop-id="${s.stop_id}" data-lat="${s.stop_lat}" data-lon="${s.stop_lon}">${s.stop_name}${s.platform_code ? ` <span style="color:var(--muted);font-size:0.85em">Läge ${s.platform_code}</span>` : ""}</div>`
    ).join("");
    resultsEl.classList.add("visible");

    resultsEl.querySelectorAll(".search-result-item").forEach(item => {
        item.addEventListener("click", () => {
            const lat = parseFloat(item.dataset.lat);
            const lon = parseFloat(item.dataset.lon);
            const stopId = item.dataset.stopId;

            searchInput.value = "";
            resultsEl.classList.remove("visible");
            resultsEl.innerHTML = "";

            if (state.map) {
                state.map.flyTo([lat, lon], 17, { duration: 0.5 });
            }

            // Try to show departures for this stop
            const marker = state.stopMarkerMap?.[stopId];
            if (marker) {
                const stop = marker._stopData || marker.options?._stopData;
                if (stop && window._showStopDepartures) {
                    setTimeout(() => window._showStopDepartures(stop, marker), 600);
                }
            }
        });
    });
}
