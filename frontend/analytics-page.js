/**
 * analytics-page.js — Punctuality, delay trends, and peak hour analysis.
 *
 * Renders three visualisations from /api/analytics/* endpoints:
 *   1. Punctuality cards per route (on-time percentage + bar)
 *   2. Delay trend line chart (SVG, multi-line)
 *   3. Peak hours heatmap (hour × weekday table)
 */

/* global ALLOWED_LINE_NUMBERS, LINE_COLORS_CUSTOM, LINE_CONFIG */

const API = "/api/analytics";
let currentDays = 7;

// Only show lines that are displayed on the map
const _allowed = typeof ALLOWED_LINE_NUMBERS !== "undefined" ? ALLOWED_LINE_NUMBERS : new Set();

function isAllowed(routeShortName) {
    return _allowed.size === 0 || _allowed.has(routeShortName);
}

// Shared line colors — consistent with config.js palette
const ROUTE_COLORS = [
    "#E63946", "#457B9D", "#2A9D8F", "#E9C46A", "#F4A261",
    "#264653", "#6A0572", "#AB83A1", "#118AB2", "#073B4C",
    "#D62828", "#F77F00", "#FCBF49", "#2EC4B6", "#FF6B6B",
    "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#636E72",
];

function routeColor(idx) {
    return ROUTE_COLORS[idx % ROUTE_COLORS.length];
}

// Use config.js custom colors when available
function getConfigColor(routeShortName) {
    if (typeof LINE_COLORS_CUSTOM === "undefined") return null;
    if (LINE_COLORS_CUSTOM[routeShortName]) return `#${LINE_COLORS_CUSTOM[routeShortName].bg}`;
    if (typeof LINE_CONFIG !== "undefined" && LINE_CONFIG.lansbuss &&
        LINE_CONFIG.lansbuss.includes(routeShortName) && LINE_COLORS_CUSTOM.lansbuss) {
        return `#${LINE_COLORS_CUSTOM.lansbuss.bg}`;
    }
    return null;
}

function routeColorFor(routeShortName, idx) {
    return getConfigColor(routeShortName) || routeColor(idx);
}

function pctColor(pct) {
    if (pct >= 80) return "var(--green)";
    if (pct >= 60) return "var(--yellow)";
    if (pct >= 40) return "var(--orange)";
    return "var(--red)";
}

// --- Data fetching ---

async function fetchJSON(endpoint, days) {
    const r = await fetch(`${API}/${endpoint}?days=${days}`);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
}

// --- 1. Punctuality cards ---

function renderPunctuality(data) {
    const container = document.getElementById("punctuality-grid");
    if (!data || data.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📊</div>
                <div class="empty-state-text">Ingen punktlighetsdata ännu. Data samlas in automatiskt från GTFS-RT.</div>
            </div>`;
        return;
    }

    // Filter to allowed lines, then sort by on_time_pct descending
    const filtered = data.filter(r => isAllowed(r.route_short_name));
    const sorted = filtered.sort((a, b) => b.on_time_pct - a.on_time_pct);

    if (sorted.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📊</div>
                <div class="empty-state-text">Ingen punktlighetsdata ännu. Data samlas in automatiskt från GTFS-RT.</div>
            </div>`;
        return;
    }

    container.innerHTML = sorted.map((r, i) => {
        const color = pctColor(r.on_time_pct);
        return `
        <div class="punct-card">
            <div class="punct-header">
                <span class="punct-badge" style="background:${routeColorFor(r.route_short_name, i)}">${r.route_short_name}</span>
                <span class="punct-pct" style="color:${color}">${r.on_time_pct}%</span>
            </div>
            <div class="punct-bar">
                <div class="punct-bar-fill" style="width:${r.on_time_pct}%;background:${color}"></div>
            </div>
            <div class="punct-meta">
                <span>Snitt: ${r.avg_delay_min > 0 ? "+" : ""}${r.avg_delay_min} min</span>
                <span>${r.total_samples} mätpunkter</span>
            </div>
            <div class="punct-meta">
                <span>Sen: ${r.late_pct}%</span>
                <span>Max: +${r.worst_delay_min} min</span>
            </div>
        </div>`;
    }).join("");
}

// --- 2. Delay trend chart (SVG line chart) ---

let trendData = {};
let activeRoutes = new Set();
let routeColorMap = {};

function renderTrendFilters(routes) {
    const container = document.getElementById("trend-filters");
    routeColorMap = {};
    routes.forEach((rsn, i) => { routeColorMap[rsn] = routeColorFor(rsn, i); });

    container.innerHTML = routes.map((rsn, i) => {
        const active = activeRoutes.has(rsn);
        const color = routeColor(i);
        return `<button class="trend-filter-btn${active ? " active" : ""}"
                data-route="${rsn}"
                style="${active ? `background:${color};border-color:${color}` : ""}">${rsn}</button>`;
    }).join("");

    container.querySelectorAll(".trend-filter-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const rsn = btn.dataset.route;
            if (activeRoutes.has(rsn)) activeRoutes.delete(rsn);
            else activeRoutes.add(rsn);
            renderTrendFilters(routes);
            renderTrendChart();
        });
    });
}

function renderTrendChart() {
    const container = document.getElementById("trend-chart");
    const legend = document.getElementById("trend-legend");

    const routesToShow = activeRoutes.size > 0
        ? [...activeRoutes].filter(r => trendData[r])
        : Object.keys(trendData).slice(0, 5);

    if (routesToShow.length === 0 || Object.keys(trendData).length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📈</div>
                <div class="empty-state-text">Ingen trenddata ännu. Data byggs upp automatiskt.</div>
            </div>`;
        legend.innerHTML = "";
        return;
    }

    // Find data range
    let allPoints = [];
    routesToShow.forEach(rsn => {
        (trendData[rsn] || []).forEach(p => allPoints.push(p));
    });
    if (allPoints.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-text">Ingen data för valda linjer</div></div>';
        legend.innerHTML = "";
        return;
    }

    const times = allPoints.map(p => new Date(p.hour_iso).getTime());
    const delays = allPoints.map(p => p.avg_delay_min);
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const maxD = Math.max(1, Math.max(...delays));

    const W = 900, H = 250;
    const PAD = { top: 20, right: 20, bottom: 40, left: 50 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    function scaleX(t) { return PAD.left + (maxT > minT ? ((t - minT) / (maxT - minT)) * plotW : plotW / 2); }
    function scaleY(d) { return PAD.top + plotH - (d / maxD) * plotH; }

    // Grid lines
    let gridLines = "";
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
        const val = (maxD / yTicks) * i;
        const y = scaleY(val);
        gridLines += `<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
        gridLines += `<text x="${PAD.left - 8}" y="${y + 4}" text-anchor="end" fill="#8e8e93" font-size="11">${val.toFixed(1)}</text>`;
    }

    // Y-axis label
    gridLines += `<text x="14" y="${PAD.top + plotH / 2}" text-anchor="middle" fill="#8e8e93" font-size="11" transform="rotate(-90,14,${PAD.top + plotH / 2})">Försening (min)</text>`;

    // X-axis labels (show a few dates)
    const xRange = maxT - minT;
    const xSteps = Math.min(8, Math.ceil(xRange / (3600000 * 6)));
    for (let i = 0; i <= xSteps; i++) {
        const t = minT + (xRange / xSteps) * i;
        const x = scaleX(t);
        const d = new Date(t);
        const label = `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, "0")}:00`;
        gridLines += `<text x="${x}" y="${H - 8}" text-anchor="middle" fill="#8e8e93" font-size="10">${label}</text>`;
    }

    // Zero line
    gridLines += `<line x1="${PAD.left}" y1="${scaleY(0)}" x2="${W - PAD.right}" y2="${scaleY(0)}" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="4 3"/>`;

    // Lines
    let paths = "";
    routesToShow.forEach(rsn => {
        const points = trendData[rsn] || [];
        if (points.length < 2) return;
        const color = routeColorMap[rsn] || "#888";
        const sorted = [...points].sort((a, b) => new Date(a.hour_iso) - new Date(b.hour_iso));
        const d = sorted.map(p => {
            const x = scaleX(new Date(p.hour_iso).getTime());
            const y = scaleY(p.avg_delay_min);
            return `${x},${y}`;
        }).join(" L ");
        paths += `<path d="M ${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`;
    });

    container.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
            ${gridLines}
            ${paths}
        </svg>`;

    // Legend
    legend.innerHTML = routesToShow.map(rsn => {
        const color = routeColorMap[rsn] || "#888";
        return `<div class="trend-legend-item"><div class="trend-legend-dot" style="background:${color}"></div>${rsn}</div>`;
    }).join("");
}

// --- 3. Peak hours heatmap ---

const WEEKDAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];

function renderHeatmap(data) {
    const container = document.getElementById("heatmap");
    const legend = document.getElementById("heatmap-legend");

    if (!data || data.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🗓️</div>
                <div class="empty-state-text">Ingen fordonsdata ännu. Heatmap byggs upp automatiskt.</div>
            </div>`;
        legend.innerHTML = "";
        return;
    }

    // Build grid: weekday (0-6) × hour (0-23)
    const grid = {};
    let maxVal = 0;
    data.forEach(d => {
        const key = `${d.weekday}-${d.hour_of_day}`;
        const val = Math.round(d.avg_total);
        grid[key] = val;
        if (val > maxVal) maxVal = val;
    });

    // Color scale: dark blue → green → yellow → red
    function heatColor(val) {
        if (maxVal === 0) return "var(--bg3)";
        const t = val / maxVal;
        if (t < 0.25) return `rgba(30, 136, 229, ${0.3 + t * 2})`;
        if (t < 0.5) return `rgba(76, 175, 80, ${0.4 + (t - 0.25) * 2})`;
        if (t < 0.75) return `rgba(255, 214, 0, ${0.5 + (t - 0.5) * 2})`;
        return `rgba(244, 67, 54, ${0.6 + (t - 0.75) * 1.6})`;
    }

    let html = '<table class="heatmap-table"><thead><tr><th></th>';
    for (let h = 0; h < 24; h++) {
        html += `<th>${String(h).padStart(2, "0")}</th>`;
    }
    html += "</tr></thead><tbody>";

    for (let wd = 0; wd < 7; wd++) {
        html += `<tr><td class="hm-day-label">${WEEKDAYS[wd]}</td>`;
        for (let h = 0; h < 24; h++) {
            const val = grid[`${wd}-${h}`] || 0;
            const bg = val > 0 ? heatColor(val) : "var(--bg3)";
            html += `<td><div class="hm-cell" style="background:${bg}" title="${WEEKDAYS[wd]} ${String(h).padStart(2,"0")}:00 — ${val} fordon">${val || ""}</div></td>`;
        }
        html += "</tr>";
    }
    html += "</tbody></table>";
    container.innerHTML = html;

    // Legend
    const steps = 5;
    let legendHtml = '<span>Färre</span><div class="hm-legend-gradient">';
    for (let i = 0; i < steps; i++) {
        const val = (maxVal / steps) * (i + 1);
        legendHtml += `<div class="hm-legend-stop" style="background:${heatColor(val)}"></div>`;
    }
    legendHtml += '</div><span>Fler fordon</span>';
    legend.innerHTML = legendHtml;
}

// --- Period selector ---

function updatePeriodLabels() {
    const label = currentDays === 1 ? "senaste 24 timmarna"
                : currentDays <= 7 ? `senaste ${currentDays} dagar`
                : `senaste ${currentDays} dagar`;
    document.getElementById("punct-period").textContent = label;
    document.getElementById("trend-period").textContent = label;
    document.getElementById("peak-period").textContent = label;
}

// --- Load all data ---

async function loadAll() {
    updatePeriodLabels();

    const [punctuality, trends, peaks] = await Promise.allSettled([
        fetchJSON("punctuality", currentDays),
        fetchJSON("trends", currentDays),
        fetchJSON("peak-hours", currentDays),
    ]);

    if (punctuality.status === "fulfilled") {
        renderPunctuality(punctuality.value);
    }

    if (trends.status === "fulfilled") {
        // Filter to allowed lines
        const raw = trends.value;
        trendData = {};
        for (const [rsn, points] of Object.entries(raw)) {
            if (isAllowed(rsn)) trendData[rsn] = points;
        }
        const routes = Object.keys(trendData).sort();
        if (activeRoutes.size === 0 && routes.length > 0) {
            routes.slice(0, 3).forEach(r => activeRoutes.add(r));
        }
        renderTrendFilters(routes);
        renderTrendChart();
    }

    if (peaks.status === "fulfilled") {
        renderHeatmap(peaks.value);
    }
}

// --- Init ---

document.querySelectorAll(".period-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".period-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentDays = parseInt(btn.dataset.days, 10);
        loadAll();
    });
});

loadAll();
// Auto-refresh every 5 minutes
setInterval(loadAll, 5 * 60 * 1000);
