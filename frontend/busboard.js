import { fetchAlerts, fetchStops, fetchNextDepartures, fetchDepartures, connectSSE } from "./modules/api.js";
import { updateClock } from "./modules/utils.js";

let currentStopId = null;
let currentStopName = "";
let refreshTimer = null;
let allStops = [];
let etaCountdownTimer = null;

// --- Dark mode ---
let darkMode = localStorage.getItem("darkMode") === "true";
function applyDarkMode() {
    document.body.classList.toggle("dark", darkMode);
    document.getElementById("dark-btn").textContent = darkMode ? "☀️" : "🌙";
}
applyDarkMode();
document.getElementById("dark-btn").addEventListener("click", () => {
    darkMode = !darkMode;
    localStorage.setItem("darkMode", darkMode);
    applyDarkMode();
});

// --- Fullscreen ---
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen();
    }
}
document.getElementById("fs-btn").addEventListener("click", toggleFullscreen);

// --- Clock ---
const clockEl = document.getElementById("clock");
setInterval(() => updateClock(clockEl), 1000);
updateClock(clockEl);

// --- Board height ---
function resizeBoard() {
    const header    = document.getElementById("header").offsetHeight;
    const alertBar  = document.getElementById("alert-banner").offsetHeight;
    const searchBar = document.getElementById("search-bar").offsetHeight;
    const bar       = document.getElementById("refresh-bar").offsetHeight;
    const wrap      = document.getElementById("board-wrap");
    wrap.style.position = "absolute";
    wrap.style.top      = (header + alertBar + searchBar + bar) + "px";
    wrap.style.bottom   = "0";
    wrap.style.left     = "0";
    wrap.style.right    = "0";
}
window.addEventListener("resize", resizeBoard);
resizeBoard();

// --- Read URL params ---
const params = new URLSearchParams(location.search);
if (params.get("stop_id")) {
    currentStopId   = params.get("stop_id");
    currentStopName = params.get("stop_name") || currentStopId;
    document.getElementById("stop-title").textContent       = currentStopName;
    document.getElementById("stop-subtitle-text").textContent = "LTlive · Avgångstavla";
    document.getElementById("stop-search").value            = currentStopName;
    document.getElementById("share-btn").classList.add("visible");
    loadDepartures();
}

// --- Share / copy URL ---
document.getElementById("share-btn").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(location.href);
        const btn = document.getElementById("share-btn");
        btn.textContent = "✓";
        setTimeout(() => { btn.textContent = "🔗"; }, 1500);
    } catch {}
});

// --- ETA formatting ---
function formatEta(secs) {
    if (secs <= 0) return { text: "Nu", cls: "eta-now" };
    if (secs < 60) return { text: `${secs} s`, cls: "eta-now" };
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    const cls = m < 3 ? "eta-soon" : "eta-normal";
    return { text: `${m}:${String(s).padStart(2, "0")}`, cls };
}

// --- Live countdown ---
function startCountdown() {
    clearInterval(etaCountdownTimer);
    etaCountdownTimer = setInterval(() => {
        const now = Date.now() / 1000;
        document.querySelectorAll(".dep-eta[data-ts]").forEach(el => {
            const ts   = parseFloat(el.dataset.ts);
            const secs = Math.round(ts - now);
            const { text, cls } = formatEta(secs);
            el.textContent = text;
            el.className   = `dep-eta ${cls}`;
            const row = el.closest(".dep-row");
            if (row) row.classList.toggle("dep-now", secs <= 0);
        });
    }, 1000);
}

// --- Load stops for search ---
let stopHeadsigns = {};
async function loadStops() {
    try {
        const [stopsData, nextDep] = await Promise.all([
            fetchStops(),
            fetchNextDepartures(),
        ]);
        allStops = stopsData.stops || [];
        for (const [sid, info] of Object.entries(nextDep)) {
            if (info.headsign) stopHeadsigns[sid] = info.headsign;
        }
    } catch {}
}
loadStops();

// --- Search ---
const searchInput   = document.getElementById("stop-search");
const searchResults = document.getElementById("search-results");

searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) { searchResults.classList.remove("open"); return; }
    const matches = allStops
        .filter(s => s.stop_name.toLowerCase().includes(q) && s.location_type !== 1)
        .slice(0, 12);
    if (matches.length === 0) { searchResults.classList.remove("open"); return; }
    searchResults.innerHTML = matches.map(s => {
        const dir = stopHeadsigns[s.stop_id];
        const sub = dir ? `<span class="search-result-dir">mot ${dir}</span>` : "";
        return `<div class="search-result-item" data-id="${s.stop_id}" data-name="${s.stop_name}">${s.stop_name}${sub}</div>`;
    }).join("");
    searchResults.style.top   = (searchInput.offsetHeight + 4) + "px";
    searchResults.style.width = searchInput.offsetWidth + "px";
    searchResults.classList.add("open");
});

searchResults.addEventListener("click", e => {
    const item = e.target.closest(".search-result-item");
    if (!item) return;
    selectStop(item.dataset.id, item.dataset.name);
    searchResults.classList.remove("open");
    loadDepartures();
});

document.addEventListener("click", e => {
    if (!e.target.closest("#search-wrap")) searchResults.classList.remove("open");
});

function selectStop(id, name) {
    currentStopId   = id;
    currentStopName = name;
    searchInput.value = name;
    document.getElementById("stop-title").textContent         = name;
    document.getElementById("stop-subtitle-text").textContent = "LTlive · Avgångstavla";
    document.getElementById("share-btn").classList.add("visible");
    history.replaceState(null, "", `?stop_id=${encodeURIComponent(id)}&stop_name=${encodeURIComponent(name)}`);
}

// --- Alerts ---
function updateAlerts(alerts) {
    const banner = document.getElementById("alert-banner");
    if (!alerts || alerts.length === 0) {
        banner.classList.remove("visible");
        banner.textContent = "";
    } else {
        banner.textContent = alerts.map(a =>
            `⚠ ${a.header}${a.description ? " — " + a.description : ""}`
        ).join("  ·  ");
        banner.classList.add("visible");
    }
    resizeBoard();
}

// --- SSE stream ---
let sseSource       = null;
let sseFallback     = null;
let sseDotEl        = document.getElementById("sse-dot");

function setSseStatus(status) {
    sseDotEl.className = "";
    sseDotEl.classList.add(status);  // "live" | "polling" | "error"
}

function initSSE() {
    if (sseSource) { sseSource.close(); sseSource = null; }

    sseSource = connectSSE(
        () => {},                                       // onVehicles – not needed here
        (data) => updateAlerts(data.alerts),            // onAlerts
        () => {                                         // onError
            setSseStatus("error");
            if (!sseFallback) {
                setSseStatus("polling");
                sseFallback = setInterval(() => { loadDepartures(); }, 20000);
            }
        },
        () => {                                         // onOpen
            setSseStatus("live");
            if (sseFallback) { clearInterval(sseFallback); sseFallback = null; }
        },
        (data) => {                                     // onVehiclesDelta
            if (!currentStopId) return;
            const relevant = (data.updated || []).some(
                v => v.next_stop_id === currentStopId || v.next_stop_name === currentStopName
            );
            if (relevant) loadDepartures();
        },
    );
}

// Fetch initial alerts
fetchAlerts().then(d => updateAlerts(d.alerts)).catch(() => {});
initSSE();

// --- Load departures ---
async function loadDepartures() {
    if (!currentStopId) return;
    const board = document.getElementById("board");
    if (!board.querySelector(".dep-row")) {
        board.innerHTML = `<div class="board-msg">Hämtar avgångar…</div>`;
    }

    try {
        const data = await fetchDepartures(currentStopId, 20);
        renderBoard(data.departures || []);
    } catch {
        board.innerHTML = `<div class="board-msg">Kunde inte hämta avgångar</div>`;
    }

    // Refresh bar animation
    const bar = document.getElementById("refresh-bar");
    bar.style.transition = "none";
    bar.style.transform  = "scaleX(0)";
    requestAnimationFrame(() => {
        bar.style.transition = "transform 20s linear";
        bar.style.transform  = "scaleX(1)";
    });

    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadDepartures, 20000);
}

function renderBoard(departures) {
    const board = document.getElementById("board");
    const now   = Date.now() / 1000;

    if (departures.length === 0) {
        board.innerHTML = `<div class="board-msg">Inga kommande avgångar</div>`;
        return;
    }

    board.innerHTML = departures.map(d => {
        const secs             = Math.round(d.departure_time - now);
        const { text: etaText, cls: etaCls } = formatEta(secs);
        const clock            = new Date(d.departure_time * 1000)
            .toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
        const rt               = d.is_realtime ? `<span class="dep-rt-badge">RT</span>` : "";
        const nowClass         = secs <= 0 ? "dep-now" : "";
        const platformHtml     = d.platform_code
            ? `<span class="dep-platform">Läge ${d.platform_code}</span>` : "";
        const mapLink          = d.route_id
            ? `<a href="/?line=${encodeURIComponent(d.route_short_name || d.route_id)}" title="Visa på karta" class="map-link">🗺</a>` : "";
        return `<div class="dep-row ${nowClass}" data-bg="${d.route_color || '555'}" data-fg="${d.route_text_color || 'fff'}">
            <div class="dep-badge-wrap">
                <span class="dep-badge" data-bg="${d.route_color || '555'}" data-fg="${d.route_text_color || 'fff'}">${d.route_short_name || "?"}</span>
                ${platformHtml}
            </div>
            <span class="dep-headsign">${d.headsign || ""}${rt}${mapLink ? `<span class="dep-headsign-sub">${mapLink} Se på karta</span>` : ""}</span>
            <span class="dep-clock">${clock}</span>
            <span class="dep-eta ${etaCls}" data-ts="${d.departure_time}">${etaText}</span>
        </div>`;
    }).join("");

    // Apply dynamic badge colors via JS (avoids inline style= attributes)
    board.querySelectorAll(".dep-badge[data-bg]").forEach(el => {
        el.style.background = `#${el.dataset.bg}`;
        el.style.color      = `#${el.dataset.fg}`;
    });

    startCountdown();
}
