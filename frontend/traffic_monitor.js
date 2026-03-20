/**
 * Traffic inference monitor — /traffic_monitor.html
 * Polls /api/traffic/monitor every 5 s and renders a live dashboard.
 * All styling via CSS classes — no inline style attributes (CSP compliance).
 */

const API = "/api/traffic/monitor";
let _timer = null;

// ── Helpers ──────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtAge(s) {
  if (s == null) return "–";
  if (s < 60)   return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  return Math.round(s / 3600) + "h";
}

function sevBadge(sev) {
  return `<span class="sev-badge sev-${esc(sev)}">${esc(sev)}</span>`;
}

function zoneTags(row) {
  let t = "";
  if (row.stop_zone)     t += `<span class="zone-tag zone-stop">hållplats</span>`;
  if (row.signal_zone)   t += `<span class="zone-tag zone-signal">signal</span>`;
  if (row.terminal_zone) t += `<span class="zone-tag zone-terminal">terminal</span>`;
  return t || "–";
}

/** Severity class from speed ratio (speed/baseline). */
function ratioSev(speed, baseline) {
  if (!baseline || !speed) return "none";
  const r = speed / baseline;
  if (r >= 0.85) return "none";
  if (r >= 0.65) return "low";
  if (r >= 0.45) return "medium";
  return "high";
}

function speedCell(speed, baseline) {
  if (!speed) return "–";
  const sev = ratioSev(speed, baseline);
  const pct = baseline ? Math.round(Math.min(1, speed / baseline) * 100) : 100;
  return `<div class="speed-cell">
    <span>${speed} km/h</span>
    <div class="bar-wrap"><div class="bar-fill bar-sev-${sev}" data-pct="${pct}"></div></div>
    <span class="speed-pct">${pct}%</span>
  </div>`;
}

function confClass(c) {
  if (c >= 0.7) return "conf-good";
  if (c >= 0.4) return "conf-warn";
  return "conf-bad";
}

// ── Apply data-driven styles after innerHTML (bar widths) ─────────────

function applyBarWidths(container) {
  container.querySelectorAll(".bar-fill[data-pct]").forEach(el => {
    el.style.width = el.dataset.pct + "%";
  });
  container.querySelectorAll(".hg-cell[data-opacity]").forEach(el => {
    el.style.opacity = el.dataset.opacity;
  });
}

// ── Clock ─────────────────────────────────────────────────────────────

function startClock() {
  const el = document.getElementById("clock");
  function tick() { el.textContent = new Date().toLocaleTimeString("sv-SE"); }
  tick();
  setInterval(tick, 1000);
}

// ── Render ────────────────────────────────────────────────────────────

function render(d) {
  const page = document.getElementById("page");

  // ── System overview ──────────────────────────────────────────────
  const builtPill = d.built
    ? `<div class="spill ok"><span class="dot"></span><span class="label">Status</span><span class="val">Klar</span></div>`
    : `<div class="spill err"><span class="dot"></span><span class="label">Status</span><span class="val">Byggs…</span></div>`;

  const overviewHtml = `
    <div class="card">
      <div class="card-header"><h2>Systemöversikt</h2><span class="meta">${esc(d.generated_at)}</span></div>
      <div class="card-body">
        <div id="sysstatus">
          ${builtPill}
          <div class="spill"><span class="label">Segment totalt</span><span class="val">${d.total_segments}</span></div>
          <div class="spill"><span class="label">Med observationer</span><span class="val ${d.segments_with_obs > 0 ? "txt-success" : "txt-dim"}">${d.segments_with_obs}</span></div>
          <div class="spill"><span class="label">Fordon aktiva</span><span class="val ${d.vehicles_tracked > 0 ? "txt-success" : "txt-dim"}">${d.vehicles_tracked}</span></div>
          <div class="spill"><span class="label">Baslinje-nycklar</span><span class="val">${d.baseline_keys}</span></div>
        </div>
      </div>
    </div>`;

  // ── Severity + zones ─────────────────────────────────────────────
  const sv = d.severity_distribution;
  const active = (sv.low || 0) + (sv.medium || 0) + (sv.high || 0);
  const sevHtml = `
    <div class="card">
      <div class="card-header"><h2>Svårighetsgrad &amp; Zoner</h2></div>
      <div class="card-body">
        <div class="stats-grid">
          <div class="stat-box ${active > 0 ? "warn" : ""}">
            <div class="sval">${active}</div><div class="slabel">Aktiva störningar</div>
          </div>
          <div class="stat-box"><div class="sval txt-dim">${sv.none || 0}</div><div class="slabel">Ingen</div></div>
          <div class="stat-box ${sv.low > 0 ? "warn" : ""}">
            <div class="sval sval-low">${sv.low || 0}</div><div class="slabel">Låg</div>
          </div>
          <div class="stat-box ${sv.medium > 0 ? "warn" : ""}">
            <div class="sval sval-medium">${sv.medium || 0}</div><div class="slabel">Medel</div>
          </div>
          <div class="stat-box ${sv.high > 0 ? "bad" : ""}">
            <div class="sval sval-high">${sv.high || 0}</div><div class="slabel">Hög</div>
          </div>
          <div class="stat-box"><div class="sval">${d.zones.stop}</div><div class="slabel">Hållplatszoner</div></div>
          <div class="stat-box"><div class="sval">${d.zones.signal}</div><div class="slabel">Signalzoner</div></div>
          <div class="stat-box"><div class="sval">${d.zones.terminal}</div><div class="slabel">Terminalzoner</div></div>
        </div>
      </div>
    </div>`;

  // ── Segments table ───────────────────────────────────────────────
  let segRows = "";
  if (!d.segments || d.segments.length === 0) {
    segRows = `<tr><td colspan="9" class="txt-dim" style="padding:12px;text-align:center">Inga observationer ännu — väntar på fordon…</td></tr>`;
  } else {
    for (const r of d.segments) {
      const mapLink = (r.lat && r.lon)
        ? `<a href="/?lat=${r.lat}&lon=${r.lon}&zoom=17" target="_blank" class="txt-muted-sm">↗</a>`
        : "";
      segRows += `
        <tr>
          <td class="td-mono txt-dim">${esc(r.segment_id.slice(-14))} ${mapLink}</td>
          <td><span class="obs-pill">${r.obs_count}</span></td>
          <td>${r.vehicles} / ${r.routes}</td>
          <td>${speedCell(r.speed_median, r.baseline_mean)}</td>
          <td class="txt-muted">${r.baseline_mean != null ? r.baseline_mean + " km/h" : "<span class='txt-dim'>ingen</span>"} <span class="txt-dim">(n=${r.baseline_count})</span></td>
          <td>${sevBadge(r.severity)}</td>
          <td class="${confClass(r.confidence)}">${Math.round(r.confidence * 100)}%</td>
          <td>${zoneTags(r)}</td>
          <td class="age-cell ${r.last_obs_age_s > 60 ? "stale" : ""}">${fmtAge(r.last_obs_age_s)}</td>
        </tr>`;
    }
  }
  const segHtml = `
    <div class="card">
      <div class="card-header"><h2>Segment med observationer</h2><span class="meta">Topp ${d.segments.length} av ${d.segments_with_obs}</span></div>
      <div class="card-body" style="padding:0;overflow-x:auto">
        <table class="lines-table">
          <thead><tr>
            <th>Segment-ID</th><th>Obs</th><th>Fordon/Linjer</th>
            <th>Hastighet (median)</th><th>Baslinje</th>
            <th>Svårighetsgrad</th><th>Konfidens</th><th>Zoner</th><th>Sedan</th>
          </tr></thead>
          <tbody>${segRows}</tbody>
        </table>
      </div>
    </div>`;

  // ── Baseline hour-coverage grid ──────────────────────────────────
  const DAYS = ["weekday", "saturday", "sunday"];
  const DAY_LABELS = { weekday: "Vardag", saturday: "Lördag", sunday: "Söndag" };

  let headerRow = `<div class="hg-row-label"></div>`;
  for (let h = 0; h < 24; h++) {
    headerRow += `<div class="hg-header">${String(h).padStart(2, "0")}</div>`;
  }

  let gridRows = headerRow;
  for (const day of DAYS) {
    gridRows += `<div class="hg-row-label">${DAY_LABELS[day]}</div>`;
    for (let h = 0; h < 24; h++) {
      const key   = `${day}:${h}`;
      const count = d.hour_coverage[key] || 0;
      const cls   = count > 0 ? "hg-cell has-data" : "hg-cell";
      const title = `${DAY_LABELS[day]} ${String(h).padStart(2,"0")}:00 — ${count} segment med ≥5 obs`;
      if (count > 0) {
        const opacity = Math.min(1, 0.3 + count / 500).toFixed(2);
        gridRows += `<div class="${cls}" data-opacity="${opacity}" title="${title}"></div>`;
      } else {
        gridRows += `<div class="${cls}" title="${title}"></div>`;
      }
    }
  }
  const baselineHtml = `
    <div class="card">
      <div class="card-header"><h2>Baslinje-täckning</h2><span class="meta">${d.baseline_keys} nycklar totalt</span></div>
      <div class="card-body">
        <p class="txt-muted-sm" style="margin-bottom:10px">Varje ruta = en timme. Grön = minst ett segment har ≥5 observationer. Mörkare = fler segment.</p>
        <div id="hour-grid">${gridRows}</div>
      </div>
    </div>`;

  // ── Live vehicles ────────────────────────────────────────────────
  let vehChips = "";
  if (!d.vehicles_live || d.vehicles_live.length === 0) {
    vehChips = `<span class="txt-dim">Inga fordon spåras just nu</span>`;
  } else {
    for (const v of d.vehicles_live) {
      const stale = v.age_s > 30;
      vehChips += `<div class="veh-chip"><span>${esc(v.vehicle_id)}</span><span class="age ${stale ? "stale" : ""}">${fmtAge(v.age_s)}</span></div>`;
    }
  }
  const vehHtml = `
    <div class="card">
      <div class="card-header"><h2>Spårade fordon</h2><span class="meta">${d.vehicles_tracked} st</span></div>
      <div class="card-body"><div id="vehicles-grid">${vehChips}</div></div>
    </div>`;

  page.innerHTML = overviewHtml + sevHtml + segHtml + baselineHtml + vehHtml;
  applyBarWidths(page);
}

// ── Fetch ─────────────────────────────────────────────────────────────

async function load() {
  try {
    const resp = await fetch(API);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    document.getElementById("loading")?.remove();
    render(data);
  } catch (e) {
    document.getElementById("page").innerHTML =
      `<div class="card"><div class="card-body txt-error">Fel: ${esc(String(e))}</div></div>`;
  }
}

// ── Init ──────────────────────────────────────────────────────────────

startClock();
load();
_timer = setInterval(load, 5000);
document.getElementById("refresh-btn").addEventListener("click", () => {
  clearInterval(_timer);
  load();
  _timer = setInterval(load, 5000);
});
