import { fetchStatus, fetchStats, fetchVehicles, fetchAlerts, connectSSE } from "./modules/api.js";

// Chip colors — mirrors config.js logic for Stadstrafiken / Länsbuss
const LINE_COLORS_CUSTOM = {
    "1":  { bg: "5B2D8E", text: "FFFFFF" },
    "2":  { bg: "2E8B3A", text: "FFFFFF" },
    "3":  { bg: "E87722", text: "FFFFFF" },
    "4":  { bg: "1A7A7A", text: "FFFFFF" },
    "5":  { bg: "1565C0", text: "FFFFFF" },
    "6":  { bg: "F5C800", text: "1C1C1E" },
    "7":  { bg: "D4607A", text: "FFFFFF" },
    lansbuss: { bg: "7B5C3E", text: "FFFFFF" },
};
const LINE_CONFIG_LANSBUSS = [
    "200","230","300","308","314","324","351","400","401","403","406","420","430","431","490",
    "500","502","506","520","590","593","600","620","630","700","701","710","800","807","819","820","840",
];

function lineStyle(shortName) {
    if (LINE_COLORS_CUSTOM[shortName]) return LINE_COLORS_CUSTOM[shortName];
    if (LINE_CONFIG_LANSBUSS.includes(shortName)) return LINE_COLORS_CUSTOM.lansbuss;
    return { bg: "555", text: "fff" };
}

// --- Vehicle data → UI ---
let lastVehicleTs = 0;

function updateVehicles(vehicles) {
    const buses  = vehicles.filter(v => v.vehicle_type !== "train");
    const trains = vehicles.filter(v => v.vehicle_type === "train");
    document.getElementById("cnt-total").textContent  = vehicles.length;
    document.getElementById("cnt-buses").textContent  = buses.length;
    document.getElementById("cnt-trains").textContent = trains.length;

    const seen = new Map();
    vehicles.forEach(v => {
        if (v.route_short_name && !seen.has(v.route_short_name)) seen.set(v.route_short_name, v);
    });

    const sorted = [...seen.entries()].sort(([a], [b]) => {
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b, "sv");
    });

    const wrap = document.getElementById("lines-wrap");
    const emptyEl = document.getElementById("lines-empty");

    if (sorted.length === 0) {
        wrap.innerHTML = "";
        if (!emptyEl) {
            const s = document.createElement("span");
            s.id = "lines-empty";
            s.style.color = "var(--muted)";
            s.textContent = "Inga aktiva linjer";
            wrap.appendChild(s);
        } else {
            wrap.appendChild(emptyEl);
        }
        return;
    }

    if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);

    const existingNames = new Set([...wrap.querySelectorAll(".line-chip")].map(c => c.dataset.line));
    const newNames      = new Set(sorted.map(([n]) => n));

    wrap.querySelectorAll(".line-chip").forEach(c => {
        if (!newNames.has(c.dataset.line)) wrap.removeChild(c);
    });

    sorted.forEach(([name]) => {
        if (existingNames.has(name)) return;
        const style = lineStyle(name);
        const chip  = document.createElement("span");
        chip.className    = "line-chip";
        chip.dataset.line = name;
        chip.textContent  = name;
        chip.style.background = `#${style.bg}`;
        chip.style.color      = `#${style.text}`;
        chip.title = `Linje ${name} — se på karta`;
        chip.addEventListener("click", () => {
            window.location.href = `/?line=${encodeURIComponent(name)}`;
        });
        wrap.appendChild(chip);
    });

    lastVehicleTs = Date.now();
    updateSseTime();
}

// --- Alerts ---
let lastAlertTs = 0;
const _noAlert = document.getElementById("no-alerts");  // cache once; never deleted

function updateAlerts(alerts) {
    lastAlertTs = Date.now();
    const list = document.getElementById("alerts-list");
    // Remove all children except the permanent #no-alerts element
    [...list.children].forEach(c => { if (c !== _noAlert) c.remove(); });

    if (!alerts || alerts.length === 0) {
        _noAlert.classList.remove("hidden");
        return;
    }

    _noAlert.classList.add("hidden");
    alerts.forEach(a => {
        const item = document.createElement("div");
        item.className = "alert-item";
        const hdr  = document.createElement("div");
        hdr.className   = "alert-header";
        hdr.textContent = `⚠ ${a.header || ""}`;
        item.appendChild(hdr);
        if (a.description) {
            const desc = document.createElement("div");
            desc.className   = "alert-desc";
            desc.textContent = a.description;
            item.appendChild(desc);
        }
        list.appendChild(item);
    });
}

// --- System status ---
function updateSseTime() {
    if (lastVehicleTs) {
        const secs = Math.round((Date.now() - lastVehicleTs) / 1000);
        document.getElementById("s-vehicles").textContent =
            secs < 10 ? "Just nu" : `${secs} s sedan`;
    }
    if (lastAlertTs) {
        const secs = Math.round((Date.now() - lastAlertTs) / 1000);
        document.getElementById("s-alerts-time").textContent =
            secs < 10 ? "Just nu" : `${secs} s sedan`;
    }
}
setInterval(updateSseTime, 5000);

function setGtfsStatus(loaded, error) {
    const el = document.getElementById("s-gtfs");
    if (error) { el.textContent = "Fel"; el.className = "status-val err"; }
    else if (loaded) { el.textContent = "Laddad"; el.className = "status-val ok"; }
    else { el.textContent = "Laddar…"; el.className = "status-val warn"; }
}

function setSseStatus(status) {
    const dot = document.getElementById("status-dot");
    const el  = document.getElementById("s-sse");
    dot.className   = "";
    dot.classList.add(status);
    el.textContent  = status === "live" ? "Live" : status === "error" ? "Fel" : "Ansluter";
    el.className    = `status-val ${status === "live" ? "ok" : status === "error" ? "err" : "warn"}`;
}

// --- Stats ---
async function loadStats() {
    try {
        const d = await fetchStats();
        const t = d.today || {};
        document.getElementById("stat-visits").textContent   = t.visits    ?? "–";
        document.getElementById("stat-unique").textContent   = t.unique    ?? "–";
        const dur = t.avg_duration;
        document.getElementById("stat-duration").textContent = dur != null
            ? `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`
            : "–";
        document.getElementById("stat-week").textContent = (d.week || {}).visits ?? "–";
    } catch {}
}
loadStats();
setInterval(loadStats, 5 * 60 * 1000);

// --- Status ---
async function loadStatus() {
    try {
        const d = await fetchStatus();
        setGtfsStatus(d.gtfs_loaded, d.gtfs_error);
    } catch {}
}
loadStatus();

// --- SSE ---
let _vehicleState = new Map();
let _deltaReady   = false;

function initSSE() {
    _deltaReady = false;
    setSseStatus("warn");

    connectSSE(
        (d) => {                                            // onVehicles
            _vehicleState.clear();
            (d.vehicles || []).forEach(v => { if (v.vehicle_id) _vehicleState.set(v.vehicle_id, v); });
            updateVehicles(d.vehicles || []);
            _deltaReady = true;
            document.getElementById("refresh-time").textContent = new Date().toLocaleTimeString("sv-SE");
        },
        (d) => { updateAlerts(d.alerts || []); },           // onAlerts
        () => { setSseStatus("error"); },                   // onError
        () => { setSseStatus("live"); _deltaReady = false; }, // onOpen
        (d) => {                                            // onVehiclesDelta
            if (!_deltaReady) return;
            (d.updated || []).forEach(v => { if (v.vehicle_id) _vehicleState.set(v.vehicle_id, v); });
            (d.removed || []).forEach(id => _vehicleState.delete(id));
            updateVehicles(Array.from(_vehicleState.values()));
        },
    );
}

// Initial data load
Promise.all([fetchVehicles(), fetchAlerts()]).then(([vd, ad]) => {
    updateVehicles(vd.vehicles || []);
    updateAlerts(ad.alerts || []);
}).catch(() => {});

initSSE();
