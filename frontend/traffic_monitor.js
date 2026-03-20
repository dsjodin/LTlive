/**
 * Traffic inference monitor — /traffic_monitor.html
 * Polls /api/traffic/monitor every 5 s and renders a live dashboard.
 */

const API = "/api/traffic/monitor";
let _timer = null;

// ── Helpers ──────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtAge(s) {
  if (s == null) return "–";
  if (s < 60)  return s + "s";
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

function speedBar(speed, baseline) {
  if (!baseline || !speed) return "–";
  const ratio = Math.min(1, speed / baseline);
  const pct   = Math.round(ratio * 100);
  let color = "#5de895";
  if (ratio < 0.45) color = "#F44336";
  else if (ratio < 0.65) color = "#FF9800";
  else if (ratio < 0.85) color = "#FFD600";
  return `
    <div style="display:flex;align-items:center;gap:6px">
      <span>${speed} km/h</span>
      <div class="bar-wrap" style="flex:1">
        <div class="bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span style="color:#778;font-size:10px">${pct}%</span>
    </div>`;
}

function confColor(c) {
  if (c >= 0.7) return "#5de895";
  if (c >= 0.4) return "#f0a030";
  return "#f05050";
}

// ── Clock ─────────────────────────────────────────────────────────────

function startClock() {
  const el = document.getElementById("clock");
  function tick() {
    el.textContent = new Date().toLocaleTimeString("sv-SE");
  }
  tick();
  setInterval(tick, 1000);
}

// ── Render ────────────────────────────────────────────────────────────

function render(d) {
  const page = document.getElementById("page");

  // ── System overview ─────────────────────────────────
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

  // ── Severity + zones ─────────────────────────────────
  const sv = d.severity_distribution;
  const active = (sv.low || 0) + (sv.medium || 0) + (sv.high || 0);
  const sevHtml = `
    <div class="card">
      <div class="card-header"><h2>Svårighetsgrad &amp; Zoner</h2></div>
      <div class="card-body">
        <div class="stats-grid">
          <div class="stat-box ${active > 0 ? "warn" : ""}">
            <div class="sval">${active}</div>
            <div class="slabel">Aktiva störningar</div>
          </div>
          <div class="stat-box">
            <div class="sval txt-dim">${sv.none || 0}</div>
            <div class="slabel">Ingen</div>
          </div>
          <div class="stat-box ${sv.low > 0 ? "warn" : ""}">
            <div class="sval" style="color:#FFD600">${sv.low || 0}</div>
            <div class="slabel">Låg</div>
          </div>
          <div class="stat-box ${sv.medium > 0 ? "warn" : ""}">
            <div class="sval" style="color:#FF9800">${sv.medium || 0}</div>
            <div class="slabel">Medel</div>
          </div>
          <div class="stat-box ${sv.high > 0 ? "bad" : ""}">
            <div class="sval" style="color:#F44336">${sv.high || 0}</div>
            <div class="slabel">Hög</div>
          </div>
          <div class="stat-box">
            <div class="sval">${d.zones.stop}</div>
            <div class="slabel">Hållplatszoner</div>
          </div>
          <div class="stat-box">
            <div class="sval">${d.zones.signal}</div>
            <div class="slabel">Signalzoner</div>
          </div>
          <div class="stat-box">
            <div class="sval">${d.zones.terminal}</div>
            <div class="slabel">Terminalzoner</div>
          </div>
        </div>
      </div>
    </div>`;

  // ── Segments table ───────────────────────────────────
  let segRows = "";
  if (!d.segments || d.segments.length === 0) {
    segRows = `<tr><td colspan="9" class="txt-dim" style="padding:12px;text-align:center">Inga observationer ännu — väntar på fordon…</td></tr>`;
  } else {
    for (const r of d.segments) {
      const mapLink = (r.lat && r.lon)
        ? `<a href="/?lat=${r.lat}&lon=${r.lon}&zoom=17" target="_blank" style="color:#778;font-size:10px">↗</a>`
        : "";
      const conf = r.confidence;
      const confStyle = `color:${confColor(conf)}`;
      segRows += `
        <tr>
          <td class="td-mono" style="font-size:10px">${esc(r.segment_id.slice(-12))}… ${mapLink}</td>
          <td><span class="obs-pill">${r.obs_count}</span></td>
          <td>${r.vehicles} / ${r.routes}</td>
          <td>${speedBar(r.speed_median, r.baseline_mean)}</td>
          <td style="color:#778">${r.baseline_mean != null ? r.baseline_mean + " km/h" : "<span class='txt-dim'>ingen</span>"} <span class="txt-dim">(n=${r.baseline_count})</span></td>
          <td>${sevBadge(r.severity)}</td>
          <td style="${confStyle};font-weight:600">${Math.round(conf * 100)}%</td>
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
            <th>Segment-ID</th>
            <th>Obs</th>
            <th>Fordon / Linjer</th>
            <th>Hastighet (median)</th>
            <th>Baslinje</th>
            <th>Svårighetsgrad</th>
            <th>Konfidens</th>
            <th>Zoner</th>
            <th>Sedan</th>
          </tr></thead>
          <tbody>${segRows}</tbody>
        </table>
      </div>
    </div>`;

  // ── Baseline hour-coverage grid ───────────────────────
  const DAYS = ["weekday", "saturday", "sunday"];
  const DAY_LABELS = { weekday: "Vardag", saturday: "Lördag", sunday: "Söndag" };
  let gridRows = `<div class="hg-label"></div>`;
  for (let h = 0; h < 24; h++) {
    gridRows += `<div class="hg-label">${String(h).padStart(2, "0")}</div>`;
  }
  for (const day of DAYS) {
    gridRows += `<div class="hg-label" style="color:#aab">${DAY_LABELS[day]}</div>`;
    for (let h = 0; h < 24; h++) {
      const key = `${day}:${h}`;
      const count = d.hour_coverage[key] || 0;
      const opacity = count > 0 ? Math.min(1, 0.3 + count / 500) : 0;
      const cls = count > 0 ? "hg-cell has-data" : "hg-cell";
      const title = `${DAY_LABELS[day]} ${String(h).padStart(2, "0")}:00 — ${count} segment med ≥5 obs`;
      gridRows += `<div class="${cls}" style="${count > 0 ? `opacity:${opacity.toFixed(2)}` : ""}" title="${title}"></div>`;
    }
  }
  const baselineHtml = `
    <div class="card">
      <div class="card-header"><h2>Baslinje-täckning</h2><span class="meta">${d.baseline_keys} nycklar totalt</span></div>
      <div class="card-body">
        <p class="txt-muted" style="margin-bottom:10px;font-size:11px">Varje ruta = en timme. Grön = minst ett segment har ≥5 observationer (baslinje aktiv). Mörkare = fler segment.</p>
        <div id="hour-grid">${gridRows}</div>
      </div>
    </div>`;

  // ── Live vehicles ─────────────────────────────────────
  let vehChips = "";
  if (!d.vehicles_live || d.vehicles_live.length === 0) {
    vehChips = `<span class="txt-dim">Inga fordon spåras just nu</span>`;
  } else {
    for (const v of d.vehicles_live) {
      const stale = v.age_s > 30;
      vehChips += `
        <div class="veh-chip">
          <span>${esc(v.vehicle_id)}</span>
          <span class="age ${stale ? "stale" : ""}">${fmtAge(v.age_s)}</span>
        </div>`;
    }
  }
  const vehHtml = `
    <div class="card">
      <div class="card-header"><h2>Spårade fordon</h2><span class="meta">${d.vehicles_tracked} st</span></div>
      <div class="card-body">
        <div id="vehicles-grid">${vehChips}</div>
      </div>
    </div>`;

  page.innerHTML = overviewHtml + sevHtml + segHtml + baselineHtml + vehHtml;
}

// ── Fetch & refresh ───────────────────────────────────────────────────

async function load() {
  try {
    const resp = await fetch(API);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    document.getElementById("loading")?.remove();
    render(data);
  } catch (e) {
    const page = document.getElementById("page");
    page.innerHTML = `<div class="card"><div class="card-body txt-error">Fel vid hämtning: ${esc(String(e))}</div></div>`;
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
