/**
 * trainAnnounce.js — Overlay banner for train arrivals/departures at Örebro C.
 *
 * Polls /api/departures and /api/arrivals for train events at the main station.
 * When a train is ≤ 2 minutes away, shows an animated banner under the topbar
 * for 30 seconds.
 *
 * Patterns:
 *   Arrival:   "Tåg NNN från XXX inkommer strax på spår ZZ"
 *   Departure: "Tåg NNN mot XXX via YYY, ZZZ avgår strax från spår PP"
 */

import { fetchDepartures, fetchArrivals, fetchStations } from "./api.js";

const BANNER_DURATION_MS = 30_000;
const POLL_INTERVAL_MS   = 15_000;
const TRIGGER_SECS       = 120;      // Show when ≤ 2 min away

// Track which events we've already shown so we don't repeat
const _shown = new Set();  // "dep:trainNr:scheduledTime" or "arr:..."

let _stationStopId = null;
let _pollTimer     = null;
let _bannerQueue   = [];
let _bannerVisible = false;
let _bannerTimeout = null;

// --- Find Örebro C stop_id ---

async function resolveStation() {
    const terms = ["örebro resecentrum", "örebro c", "örebro centralstation"];
    try {
        const data = await fetchStations();
        const stops = data.stations || data.stops || [];
        for (const term of terms) {
            const match = stops.find(s =>
                s.stop_name.toLowerCase().includes(term)
            );
            if (match) {
                _stationStopId = match.stop_id;
                console.log(`TrainAnnounce: resolved station "${match.stop_name}" → ${match.stop_id}`);
                return;
            }
        }
        console.warn("TrainAnnounce: could not find Örebro C station");
    } catch (e) {
        console.warn("TrainAnnounce: station resolve failed:", e);
    }
}

// --- Banner DOM ---

function getOrCreateBanner() {
    let el = document.getElementById("train-announce-banner");
    if (!el) {
        el = document.createElement("div");
        el.id = "train-announce-banner";
        el.className = "train-announce-banner";
        // Insert right after topbar
        const topbar = document.getElementById("topbar");
        if (topbar && topbar.nextSibling) {
            topbar.parentNode.insertBefore(el, topbar.nextSibling);
        } else {
            document.body.prepend(el);
        }
    }
    return el;
}

function showBanner(html) {
    const el = getOrCreateBanner();
    el.innerHTML = html;
    // Force reflow so animation restarts
    el.classList.remove("visible");
    void el.offsetWidth;
    el.classList.add("visible");
    _bannerVisible = true;

    clearTimeout(_bannerTimeout);
    _bannerTimeout = setTimeout(() => {
        el.classList.remove("visible");
        _bannerVisible = false;
        // Show next in queue after fade-out
        setTimeout(() => showNextInQueue(), 500);
    }, BANNER_DURATION_MS);
}

function showNextInQueue() {
    if (_bannerQueue.length === 0) return;
    const next = _bannerQueue.shift();
    showBanner(next);
}

function queueBanner(html) {
    if (_bannerVisible) {
        _bannerQueue.push(html);
    } else {
        showBanner(html);
    }
}

// --- Build announcement text ---

function buildDepartureHtml(dep) {
    const trainNr = dep.trip_short_name || dep.route_short_name || "?";
    const dest    = dep.headsign || "okänt";
    const track   = dep.platform || "–";
    const via     = (dep.via && dep.via.length) ? dep.via.join(", ") : "";

    let text;
    if (via) {
        text = `Tåg <strong>${trainNr}</strong> mot <strong>${dest}</strong> via ${via} avgår strax från spår <strong>${track}</strong>`;
    } else {
        text = `Tåg <strong>${trainNr}</strong> mot <strong>${dest}</strong> avgår strax från spår <strong>${track}</strong>`;
    }

    return `<div class="ta-inner ta-departure">
        <span class="ta-icon">🚆</span>
        <span class="ta-text">${text}</span>
    </div>`;
}

function buildArrivalHtml(arr) {
    const trainNr = arr.trip_short_name || arr.route_short_name || "?";
    const origin  = arr.origin || "okänt";
    const track   = arr.platform || "–";

    const text = `Tåg <strong>${trainNr}</strong> från <strong>${origin}</strong> inkommer strax på spår <strong>${track}</strong>`;

    return `<div class="ta-inner ta-arrival">
        <span class="ta-icon">🚂</span>
        <span class="ta-text">${text}</span>
    </div>`;
}

// --- Poll and check ---

async function poll() {
    if (!_stationStopId) return;
    const now = Date.now() / 1000;

    try {
        const [depData, arrData] = await Promise.all([
            fetchDepartures(_stationStopId, 10, "train"),
            fetchArrivals(_stationStopId, 10, "train"),
        ]);

        // Check departures
        for (const d of (depData.departures || [])) {
            if (d.canceled) continue;
            const secs = Math.round(d.departure_time - now);
            const key = `dep:${d.trip_short_name || d.route_short_name}:${d.scheduled_time || d.departure_time}`;
            if (secs > 0 && secs <= TRIGGER_SECS && !_shown.has(key)) {
                _shown.add(key);
                queueBanner(buildDepartureHtml(d));
            }
        }

        // Check arrivals
        for (const a of (arrData.arrivals || [])) {
            if (a.canceled) continue;
            const secs = Math.round(a.arrival_time - now);
            const key = `arr:${a.trip_short_name || a.route_short_name}:${a.scheduled_time || a.arrival_time}`;
            if (secs > 0 && secs <= TRIGGER_SECS && !_shown.has(key)) {
                _shown.add(key);
                queueBanner(buildArrivalHtml(a));
            }
        }

        // Cleanup old shown keys (older than 10 min)
        const cutoff = now - 600;
        for (const key of _shown) {
            const ts = parseInt(key.split(":").pop(), 10);
            if (ts && ts < cutoff) _shown.delete(key);
        }
    } catch (e) {
        // Non-critical — silently retry next poll
    }
}

// --- Public init ---

export async function initTrainAnnounce() {
    await resolveStation();
    if (!_stationStopId) return;

    // Create banner element early
    getOrCreateBanner();

    // Initial poll
    await poll();

    // Periodic polling
    _pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}
