import { fetchVehicles, fetchStations, fetchDepartures, fetchArrivals, fetchStationMessages } from "./modules/api.js";
import { updateClock } from "./modules/utils.js";

const REFRESH_INTERVAL = 30000; // 30 s

// Known stations: ordered list of fallback search terms tried in sequence.
// First term that finds a match wins.
const PRESET_STATIONS = {
    "orebro-c": {
        label: "Örebro Resecentrum",
        terms: ["örebro resecentrum", "örebro c", "örebro centralstation", "örebro central"],
    },
};

let currentStopId      = null;
let currentStopName    = "";
let currentMode        = "dep"; // "dep" | "arr"
let refreshTimer       = null;
let countdownTimer     = null;
let liveTibTrains      = []; // from /api/vehicles
let platformMessages   = {}; // track → [{body, status}] from Plattformsskylt

// ── Clock ──────────────────────────────────────────────
const clockEl = document.getElementById("clock");
setInterval(() => updateClock(clockEl), 1000);
updateClock(clockEl);

// ── Layout ─────────────────────────────────────────────
function resizeBoard() {
    const header    = document.getElementById("header").offsetHeight;
    const stBar     = document.getElementById("station-bar").offsetHeight;
    const modeBar   = document.getElementById("mode-bar").offsetHeight;
    const liveBar   = document.getElementById("live-status").offsetHeight;
    const refBar    = document.getElementById("refresh-bar").offsetHeight;
    const colHeader = document.getElementById("col-header").offsetHeight;
    const wrap      = document.getElementById("board-wrap");
    wrap.style.top  = (header + stBar + modeBar + liveBar + refBar + colHeader) + "px";
}
window.addEventListener("resize", resizeBoard);
resizeBoard();

// ── Fullscreen ─────────────────────────────────────────
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen();
    }
}
document.getElementById("fs-btn").addEventListener("click", toggleFullscreen);

// ── Mode toggle (event listeners) ─────────────────────
document.getElementById("tab-dep").addEventListener("click", () => setMode("dep"));
document.getElementById("tab-arr").addEventListener("click", () => setMode("arr"));

// ── Station buttons (event listeners) ─────────────────
document.querySelectorAll(".station-btn[data-station]").forEach(btn => {
    btn.addEventListener("click", () => selectStation(btn.dataset.station));
});

// ── Live TiB train positions ───────────────────────────
async function fetchLiveTrains() {
    try {
        const data = await fetchVehicles();
        liveTibTrains = (data.vehicles || []).filter(v =>
            v.source === "oxyfi" || v.route_type === 2 || (100 <= (v.route_type || 0) && (v.route_type || 0) <= 199)
        );
        updateLiveStatus();
    } catch {
        liveTibTrains = [];
    }
}

function updateLiveStatus() {
    const el = document.getElementById("live-status-text");
    if (liveTibTrains.length === 0) {
        el.textContent = "Inga aktiva tåg just nu";
        return;
    }
    const labels = liveTibTrains.map(v => {
        const name = v.route_short_name || v.label || "?";
        const spd  = v.speed != null ? ` ${Math.round(v.speed * 3.6)} km/h` : "";
        return `<span class="tib-live">${name}${spd}</span>`;
    });
    el.innerHTML = `Aktiva tåg: ${labels.join(" &nbsp;·&nbsp; ")}`;
}

// Find a live train matching a trip_id or route_short_name
function findLiveTrain(tripId, routeShortName) {
    return liveTibTrains.find(v =>
        (v.trip_id && v.trip_id === tripId) ||
        (v.route_short_name && v.route_short_name === routeShortName)
    ) || null;
}

setInterval(fetchLiveTrains, 10000);
fetchLiveTrains();

// ── Stop search ────────────────────────────────────────
let allTrainStops = [];

async function loadTrainStops() {
    try {
        // Use parent stations (location_type=1) — one entry per station,
        // not one per platform. This avoids 20 identical "Örebro Resecentrum"
        // rows in search results. The departures API expands parent → children.
        const data = await fetchStations();
        allTrainStops = (data.stops || []);
    } catch {
        allTrainStops = [];
    }
}
loadTrainStops();

const searchInput   = document.getElementById("station-search");
const searchResults = document.getElementById("station-search-results");

searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) { searchResults.classList.remove("open"); return; }
    const matches = allTrainStops
        .filter(s => s.stop_name.toLowerCase().includes(q))
        .slice(0, 10);
    if (!matches.length) { searchResults.classList.remove("open"); return; }
    searchResults.innerHTML = matches.map(s =>
        `<div class="ssr-item" data-id="${s.stop_id}" data-name="${s.stop_name}">${s.stop_name}</div>`
    ).join("");
    searchResults.classList.add("open");
});

searchResults.addEventListener("click", e => {
    const item = e.target.closest(".ssr-item");
    if (!item) return;
    searchInput.value = "";
    searchResults.classList.remove("open");
    loadStation(item.dataset.id, item.dataset.name);
});

document.addEventListener("click", e => {
    if (!e.target.closest("#station-search-wrap")) {
        searchResults.classList.remove("open");
    }
});

// ── Preset station selector ────────────────────────────
async function selectStation(key) {
    const preset = PRESET_STATIONS[key];
    if (!preset) return;

    // Update active button
    document.querySelectorAll(".station-btn").forEach((b, i) => {
        const keys = Object.keys(PRESET_STATIONS);
        b.classList.toggle("active", keys[i] === key);
    });

    if (!allTrainStops.length) await loadTrainStops();

    // Try each fallback search term in order
    let match = null;
    for (const term of preset.terms) {
        match = allTrainStops.find(s =>
            s.stop_name.toLowerCase().includes(term)
        );
        if (match) break;
    }

    if (match) {
        loadStation(match.stop_id, match.stop_name);
        return;
    }

    // Still not found — show all stops whose name starts with the
    // first word of the first search term so the user can pick.
    const firstWord = preset.terms[0].split(" ")[0];  // e.g. "örebro"
    const suggestions = allTrainStops.filter(s =>
        s.stop_name.toLowerCase().startsWith(firstWord)
    ).sort((a, b) => a.stop_name.localeCompare(b.stop_name, "sv"));

    const board = document.getElementById("board");
    if (suggestions.length) {
        board.innerHTML = `
            <div class="board-msg station-fallback">
                <div class="station-fallback-title">
                    "${preset.label}" hittades inte — välj manuellt:
                </div>
                <div class="station-fallback-list">
                    ${suggestions.map(s =>
                        `<button class="station-fallback-btn"
                            data-stop-id="${s.stop_id}"
                            data-stop-name="${s.stop_name.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">
                            ${s.stop_name}
                            <span class="station-fallback-stop-id">${s.stop_id}</span>
                        </button>`
                    ).join("")}
                </div>
            </div>`;
        board.querySelectorAll(".station-fallback-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                document.querySelector(".station-btn.active")?.classList.remove("active");
                loadStation(btn.dataset.stopId, btn.dataset.stopName);
            });
        });
    } else {
        board.innerHTML = `<div class="board-msg">
            Inga hållplatser med "${firstWord}" hittades i GTFS-data.
            Använd sökfältet ovan.
        </div>`;
    }
}

function loadStation(stopId, stopName) {
    currentStopId   = stopId;
    currentStopName = stopName;
    document.getElementById("station-title").textContent    = stopName;
    document.getElementById("station-subtitle").textContent = "Tåg i Bergslagen · Avgångar & ankomster";
    history.replaceState(null, "", `?stop_id=${encodeURIComponent(stopId)}&stop_name=${encodeURIComponent(stopName)}`);
    refreshBoard();
}

// ── Mode toggle ───────────────────────────────────────
function setMode(mode) {
    currentMode = mode;
    document.getElementById("tab-dep").classList.toggle("active", mode === "dep");
    document.getElementById("tab-arr").classList.toggle("active", mode === "arr");

    const colHdr = document.getElementById("col-header");
    if (mode === "dep") {
        colHdr.innerHTML = `
            <span>Tid</span>
            <span>Ny tid</span>
            <span>Till</span>
            <span class="col-center">Spår</span>
            <span>Tågnr</span>
            <span>Bolag</span>
            <span class="col-right">Avgår om</span>
            <span>Anmärkning</span>`;
    } else {
        colHdr.innerHTML = `
            <span>Tid</span>
            <span>Ny tid</span>
            <span>Från</span>
            <span class="col-center">Spår</span>
            <span>Tågnr</span>
            <span>Bolag</span>
            <span class="col-right">Ankommer om</span>
            <span>Anmärkning</span>`;
    }
    refreshBoard();
}

// ── Operator tag helper ───────────────────────────────
function operatorTag(operator, product) {
    const op = (operator || "").toLowerCase();
    const pr = (product  || "").toLowerCase();
    if (op.includes("mälartåg") || pr.includes("mälartåg"))
        return `<span class="op-tag op-malartag">Mälartåg</span>`;
    if (op.includes("sj"))
        return `<span class="op-tag op-sj">SJ</span>`;
    if (op.includes("arriva") || pr.includes("bergslagen"))
        return `<span class="op-tag op-tib-bergslagen">TiB</span>`;
    if (op.includes("snälltåget"))
        return `<span class="op-tag op-snalltaget">Snälltåget</span>`;
    return "";
}

function buildRemarkText(item) {
    const parts = [];
    if (item.canceled) parts.push(`<span class="canceled-badge">Inställt</span>`);
    if (item.deviation && item.deviation.length)
        parts.push(`<span class="deviation">${item.deviation.join(", ")}</span>`);
    if (item.other_info && item.other_info.length)
        parts.push(`<span class="other-info">${item.other_info.join(", ")}</span>`);
    if (item.traffic_type === "Buss")
        parts.push(`<span class="bus-tag">Buss</span>`);
    const track = item.platform;
    if (track && platformMessages[track] && platformMessages[track].length)
        parts.push(`<span class="platform-msg">${platformMessages[track].map(m => m.body).join(" · ")}</span>`);
    return parts.join(" ");
}

// ── Signal SVG (järnvägssignal) ───────────────────────
const SIGNAL_SVG = `<svg class="signal-svg" viewBox="0 0 70 76" width="46" height="50">
  <path d="M10,22 Q7,8 22,5 L48,5 Q63,8 60,22 L58,56 Q56,72 35,74 Q14,72 12,56 Z"
        fill="#111" stroke="white" stroke-width="3.5"/>
  <circle class="sig-l" cx="24" cy="26" r="11"/>
  <circle class="sig-r" cx="46" cy="26" r="11"/>
  <circle cx="35" cy="53" r="11" fill="#252525"/>
</svg>`;

// ── ETA helper ────────────────────────────────────────
function formatEta(secs, mode) {
    if (secs < -120) return { text: mode === "arr" ? "Ankommit" : "Avgått", cls: "eta-past" };
    if (secs <= 60)  return { text: "Nu", cls: "eta-now" };
    const m = Math.round(secs / 60);
    const cls = m <= 2 ? "eta-soon" : "eta-normal";
    return { text: `${m} min`, cls };
}

function startCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
        const now = Date.now() / 1000;
        document.querySelectorAll(".eta-col[data-ts]").forEach(el => {
            // Already showing signal – turn it off once train has arrived
            if (el.dataset.signal === "true") {
                const ts   = parseFloat(el.dataset.ts);
                const secs = Math.round(ts - now);
                const row  = el.closest(".row-wrap");
                if (secs <= 0) {
                    // Train has arrived — deactivate signal animation.
                    // If GPS says train is still far from station, show "Nu" instead.
                    const gpsStillFar = el.dataset.gps === "false";
                    delete el.dataset.signal;
                    const mode = el.dataset.mode || "dep";
                    let { text, cls } = formatEta(secs, mode);
                    if (gpsStillFar && text === "Ankommit") {
                        text = "Nu";
                        cls  = "eta-now";
                    }
                    el.innerHTML = text;
                    el.className = `eta-col ${cls}`;
                    if (row) {
                        row.classList.remove("row-signal");
                        row.classList.toggle("row-now",  gpsStillFar);
                        row.classList.toggle("row-past", secs < -60 && !gpsStillFar);
                    }
                } else if (row) {
                    row.classList.remove("row-past", "row-now");
                }
                return;
            }
            const ts   = parseFloat(el.dataset.ts);
            const secs = Math.round(ts - now);
            const mode = el.dataset.mode || "dep";
            const isCanceled = !!el.closest(".row-wrap")?.classList.contains("row-canceled");

            if (!isCanceled && secs > 0 && secs <= 120) {
                // Activate signal mode
                el.dataset.signal = "true";
                el.innerHTML  = SIGNAL_SVG;
                el.className  = "eta-col eta-signal";
                const row = el.closest(".row-wrap");
                if (row) {
                    row.classList.remove("row-now", "row-past");
                    row.classList.add("row-signal");
                }
                return;
            }

            let { text, cls } = formatEta(secs, mode);
            // If GPS says the train is still far from the station, don't show
            // "Ankommit" yet — override to "Nu" until GPS confirms arrival.
            if (text === "Ankommit" && el.dataset.gps === "false") {
                text = "Nu";
                cls  = "eta-now";
            }
            el.innerHTML = text;
            el.className = `eta-col ${cls}`;
            const row = el.closest(".row-wrap");
            if (row) {
                row.classList.toggle("row-now",  secs <= 30 && secs > -60 || (text === "Nu" && el.dataset.gps === "false"));
                row.classList.toggle("row-past", secs < -60 && el.dataset.gps !== "false");
            }
        });
    }, 1000);
}

// ── Station messages ──────────────────────────────────
async function loadMessages() {
    if (!currentStopId) return;
    try {
        const data = await fetchStationMessages(currentStopId);

        // Plattformsskylt: store globally so train rows can look up by track
        platformMessages = data.platform_messages || {};

        // Utrop: show as station-wide banner
        const el = document.getElementById("station-messages");
        const announcements = data.announcements || [];
        if (!announcements.length) {
            el.style.display = "none";
            el.innerHTML = "";
            return;
        }
        el.innerHTML = announcements.map(m => `
            <div class="msg-card">
                <span class="msg-icon">&#128227;</span>
                <div class="msg-body">
                    ${m.body ? `<span class="msg-text">${m.body}</span>` : ""}
                </div>
            </div>`).join("");
        el.style.display = "flex";
    } catch {
        // Non-critical — reset and hide on error
        platformMessages = {};
        document.getElementById("station-messages").style.display = "none";
    }
}

// ── Refresh ───────────────────────────────────────────
async function refreshBoard() {
    if (!currentStopId) return;
    clearTimeout(refreshTimer);

    const board = document.getElementById("board");
    if (!board.querySelector(".row")) {
        board.innerHTML = `<div class="board-msg">Hämtar…</div>`;
    }

    try {
        await loadMessages();
        if (currentMode === "dep") {
            await loadDepartures(board);
        } else {
            await loadArrivals(board);
        }
    } catch {
        board.innerHTML = `<div class="board-msg">Kunde inte hämta data</div>`;
    }

    // Refresh bar
    const bar = document.getElementById("refresh-bar");
    bar.style.transition = "none";
    bar.style.transform  = "scaleX(0)";
    bar.classList.remove("running");
    requestAnimationFrame(() => {
        bar.classList.add("running");
    });

    refreshTimer = setTimeout(refreshBoard, REFRESH_INTERVAL);
}

async function loadDepartures(board) {
    const data = await fetchDepartures(currentStopId, 20, "train");

    const deps = data.departures || [];
    if (!deps.length) {
        board.innerHTML = `<div class="board-msg">Inga kommande tåg</div>`;
        return;
    }

    const now = Date.now() / 1000;
    board.innerHTML = deps.map(d => {
        const secs  = Math.round(d.departure_time - now);
        const { text: etaText, cls: etaCls } = formatEta(secs, "dep");
        const clock = new Date(d.departure_time * 1000)
            .toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
        const nowClass     = (secs <= 30 && secs > -60) ? "row-now" : "";
        const pastClass    = secs < -60 ? " row-past" : "";
        const canceledClass = d.canceled ? " row-canceled" : "";

        const liveTrain = findLiveTrain(d.trip_id, d.route_short_name);
        const liveTag   = liveTrain
            ? `<span class="live-train"><span class="live-dot"></span>Live</span>`
            : "";
        const rtDot = d.is_realtime
            ? `<span class="rt-dot" title="Realtidsdata"></span>`
            : "";

        const trainLabel = d.trip_short_name || d.route_short_name || "?";
        const opTag = operatorTag(d.operator, d.product);
        const headsignText = d.canceled ? `<s>${d.headsign || ""}</s>` : (d.headsign || "");
        const trackChangedClass = d.track_changed ? " track-changed" : "";
        const isDelayed = d.is_realtime && d.scheduled_time && d.departure_time !== d.scheduled_time;
        const schedClock = new Date((d.scheduled_time || d.departure_time) * 1000)
            .toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
        const prelimClass = d.preliminary ? " time-prelim" : "";
        const tidHtml = isDelayed
            ? `<span class="time-col time-delayed">${schedClock}</span>`
            : `<span class="time-col${d.preliminary ? " time-prelim" : ""}">${schedClock}</span>`;
        const nytidHtml = isDelayed
            ? `<span class="newtime-col${prelimClass}">${clock}</span>`
            : `<span></span>`;
        const viaRow = (d.via && d.via.length)
            ? `<div class="via-row">${rtDot}via ${d.via.join(" · ")}</div>`
            : (d.is_realtime ? `<div class="via-row">${rtDot}Realtid</div>` : "");
        const remarkText = buildRemarkText(d);
        const useSignal  = !d.canceled && secs <= 120;
        const etaInner   = useSignal ? SIGNAL_SVG : etaText;
        const etaClass   = useSignal ? "eta-signal" : etaCls;
        const signalAttr = useSignal ? ' data-signal="true"' : '';
        return `<div class="row-wrap${useSignal ? " row-signal" + canceledClass : " " + nowClass + pastClass + canceledClass}">
            <div class="row dep-grid">
                ${tidHtml}
                ${nytidHtml}
                <span class="dest-col">${headsignText}${liveTag}</span>
                <span class="track"><span class="track-num${trackChangedClass}">${d.platform || "–"}</span></span>
                <span class="trainno-col">${trainLabel}</span>
                <span class="operator-col">${opTag}</span>
                <span class="eta-col ${etaClass}" data-ts="${d.departure_time}" data-mode="dep"${signalAttr}>${etaInner}</span>
                <span class="remark-col">${remarkText}</span>
            </div>
            ${viaRow}
        </div>`;
    }).join("");

    startCountdown();
}

async function loadArrivals(board) {
    const data = await fetchArrivals(currentStopId, 20, "train");

    const arrs = data.arrivals || [];
    if (!arrs.length) {
        board.innerHTML = `<div class="board-msg">Inga kommande ankomster</div>`;
        return;
    }

    const now = Date.now() / 1000;
    board.innerHTML = arrs.map(a => {
        const secs  = Math.round(a.arrival_time - now);
        const { text: etaText, cls: etaCls } = formatEta(secs, "arr");
        const clock = new Date(a.arrival_time * 1000)
            .toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
        const nowClass     = (secs <= 30 && secs > -60) ? "row-now" : "";
        const pastClass    = secs < -60 ? " row-past" : "";
        const canceledClass = a.canceled ? " row-canceled" : "";

        const liveTrain = findLiveTrain(a.trip_id, a.route_short_name);
        const liveTag   = liveTrain
            ? `<span class="live-train"><span class="live-dot"></span>Live</span>`
            : "";
        const rtDot = a.is_realtime
            ? `<span class="rt-dot" title="Realtidsdata"></span>`
            : "";

        const fromLabel = a.origin || "–";
        const fromDisplay = a.canceled ? `<s>${fromLabel}</s>` : fromLabel;
        const trainLabel = a.trip_short_name || a.route_short_name || "?";
        const opTag = operatorTag(a.operator, a.product);
        const arrTrackChangedClass = a.track_changed ? " track-changed" : "";
        const arrIsDelayed = a.is_realtime && a.scheduled_time && a.arrival_time !== a.scheduled_time;
        const arrPrelimClass = a.preliminary ? " time-prelim" : "";
        const arrSchedClock2 = new Date((a.scheduled_time || a.arrival_time) * 1000)
            .toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
        const arrTidHtml = arrIsDelayed
            ? `<span class="time-col time-delayed">${arrSchedClock2}</span>`
            : `<span class="time-col${a.preliminary ? " time-prelim" : ""}">${arrSchedClock2}</span>`;
        const arrNytidHtml = arrIsDelayed
            ? `<span class="newtime-col${arrPrelimClass}">${clock}</span>`
            : `<span></span>`;
        const viaRow = (a.via && a.via.length)
            ? `<div class="via-row">${rtDot}via ${a.via.join(" · ")}</div>`
            : (a.is_realtime ? `<div class="via-row">${rtDot}Realtid</div>` : "");
        const remarkText = buildRemarkText(a);
        const useSignal  = !a.canceled && secs > 0 && secs <= 120;
        // gps_at_station: true = GPS confirms at platform, false = GPS says still far, null = no data
        const gpsVal     = a.gps_at_station === true ? "true" : a.gps_at_station === false ? "false" : "unknown";
        // When GPS says train is still far away, override "Ankommit" → "Nu"
        const arrEtaText = (!useSignal && secs <= 0 && a.gps_at_station === false) ? "Nu" : etaText;
        const arrEtaCls  = (!useSignal && secs <= 0 && a.gps_at_station === false) ? "eta-now" : etaCls;
        const etaInner   = useSignal ? SIGNAL_SVG : arrEtaText;
        const etaClass   = useSignal ? "eta-signal" : arrEtaCls;
        const signalAttr = useSignal ? ' data-signal="true"' : '';
        return `<div class="row-wrap${useSignal ? " row-signal" + canceledClass : " " + nowClass + pastClass + canceledClass}">
            <div class="row arr-grid">
                ${arrTidHtml}
                ${arrNytidHtml}
                <span class="dest-col">${fromDisplay}${liveTag}</span>
                <span class="track"><span class="track-num${arrTrackChangedClass}">${a.platform || "–"}</span></span>
                <span class="trainno-col">${trainLabel}</span>
                <span class="operator-col">${opTag}</span>
                <span class="eta-col ${etaClass}" data-ts="${a.arrival_time}" data-mode="arr" data-gps="${gpsVal}"${signalAttr}>${etaInner}</span>
                <span class="remark-col">${remarkText}</span>
            </div>
            ${viaRow}
        </div>`;
    }).join("");

    startCountdown();
}

// ── URL param restore ─────────────────────────────────
const params = new URLSearchParams(location.search);
if (params.get("stop_id")) {
    loadStation(params.get("stop_id"), params.get("stop_name") || params.get("stop_id"));
} else {
    // Default: try to load Örebro C
    selectStation("orebro-c");
}

// ── Resize ────────────────────────────────────────────
new ResizeObserver(resizeBoard).observe(document.getElementById("col-header"));
resizeBoard();
