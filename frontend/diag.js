const API = '/api';
let _refreshTimer = null;

// ── Helpers ────────────────────────────────────────────────────────

function fmtAge(ts) {
  if (!ts) return '–';
  const sek = Math.round(Date.now() / 1000 - ts);
  if (sek < 60) return sek + 's';
  if (sek < 3600) return Math.round(sek / 60) + 'm';
  return Math.round(sek / 3600) + 'h';
}

function isStale(ts) {
  return ts && (Date.now() / 1000 - ts) > 60;
}

function fmtTs(epoch) {
  if (!epoch) return '–';
  return new Date(epoch * 1000).toLocaleTimeString('sv-SE');
}

function fmtSpeed(mps) {
  if (mps == null || mps === undefined) return null;
  return Math.round(mps * 3.6) + ' km/h';
}

function badgeHtml(shortName) {
  const cfg = (typeof LINE_COLORS_CUSTOM !== 'undefined') ? LINE_COLORS_CUSTOM : {};
  let bg = '555', fg = 'fff';
  if (cfg[shortName]) { bg = cfg[shortName].bg; fg = cfg[shortName].text; }
  else if (cfg.lansbuss) { bg = cfg.lansbuss.bg; fg = cfg.lansbuss.text; }
  return `<span class="line-badge" data-bg="${bg}" data-fg="${fg}">${esc(shortName)}</span>`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function pct(a, b) {
  if (!b) return '0%';
  return Math.round(100 * a / b) + '%';
}

// Apply dynamic colors to elements using data-bg / data-fg attributes
function applyDynColors(container) {
  container.querySelectorAll('[data-bg]').forEach(el => {
    el.style.background = '#' + el.dataset.bg;
    el.style.color = '#' + (el.dataset.fg || 'fff');
  });
}

// ── Fetch all data ─────────────────────────────────────────────────

async function fetchAll() {
  const [status, vehicles, matching, tvPositions] = await Promise.all([
    fetch(`${API}/status`).then(r => r.json()).catch(() => null),
    fetch(`${API}/vehicles`).then(r => r.json()).then(d => d.vehicles ?? d).catch(() => []),
    fetch(`${API}/debug/matching`).then(r => r.json()).catch(() => null),
    fetch(`${API}/debug/tv-positions`).then(r => r.json()).catch(() => null),
  ]);
  return { status, vehicles, matching, tvPositions };
}

async function fetchRtFeed() {
  return fetch(`${API}/debug/rt-feed`).then(r => r.json()).catch(e => ({ error: String(e) }));
}

// ── Render ─────────────────────────────────────────────────────────

function render({ status, vehicles, matching, tvPositions }) {
  const page = document.getElementById('page');
  page.innerHTML = '';

  // group vehicles by route_short_name
  const byLine = {};
  for (const v of vehicles) {
    const name = v.route_short_name || '__UNKNOWN__';
    (byLine[name] = byLine[name] || []).push(v);
  }

  // Show banner if debug endpoints are disabled (backend returns {"error":...})
  if (matching?.error || tvPositions?.error) {
    const banner = document.createElement('div');
    banner.className = 'debug-disabled-banner';
    banner.innerHTML = `<strong>⚠ ENABLE_DEBUG_ENDPOINTS=false</strong> — Sätt
      <code>ENABLE_DEBUG_ENDPOINTS=true</code> i <code>.env</code> och starta om
      backend för att aktivera RT-matchning, Tåg inom radien och RT-flöde rådata.`;
    page.appendChild(banner);
  }

  page.appendChild(buildSysStatus(status, vehicles.length));
  page.appendChild(buildTvPositions(tvPositions));
  page.appendChild(buildLinesTable(byLine));
  page.appendChild(buildUnconfigured(byLine));
  page.appendChild(buildMatching(matching, vehicles));

  applyDynColors(page);

  // Fetch RT feed raw stats asynchronously and append when ready
  fetchRtFeed().then(rtFeed => {
    const card = buildRtFeedCard(rtFeed);
    document.getElementById('page').appendChild(card);
    applyDynColors(card);
  });
}

// ── System status card ─────────────────────────────────────────────

function buildSysStatus(s, vehicleCount) {
  const card = makeCard('Systemstatus');
  const body = card.querySelector('.card-body');

  if (!s) {
    body.innerHTML = '<span class="txt-error">Kunde inte nå /api/status</span>';
    return card;
  }

  const gtfsOk = s.gtfs_loaded;
  const ageSek = s.last_vehicle_update ? Math.round(Date.now() / 1000 - s.last_vehicle_update) : null;

  const pollAgeSek = s.last_rt_poll ? Math.round(Date.now() / 1000 - s.last_rt_poll) : null;
  const pollCount = s.last_rt_poll_count;

  const pills = [
    pill(gtfsOk ? 'ok' : 'err', 'GTFS', gtfsOk ? 'Laddad' : 'EJ LADDAD'),
    pill('ok', 'Operatör', esc(s.operator || '–')),
    pill('ok', 'Rutter', s.routes_count),
    pill('ok', 'Hållplatser', s.stops_count),
    pill('ok', 'Turer', s.trips_count),
    pill('ok', 'Former', s.shapes_count),
    pill(vehicleCount > 0 ? 'ok' : 'warn', 'Fordon nu', vehicleCount),
    pill(ageSek != null ? (ageSek < 15 ? 'ok' : ageSek < 60 ? 'warn' : 'err') : 'warn',
         'RT-ålder', ageSek != null ? ageSek + 's' : '–'),
    pill(pollAgeSek != null ? (pollAgeSek < 20 ? 'ok' : pollAgeSek < 60 ? 'warn' : 'err') : 'err',
         'Senaste poll', pollAgeSek != null ? pollAgeSek + 's sedan' : 'aldrig'),
    pill(pollCount === null ? 'warn' : pollCount > 0 ? 'ok' : 'warn',
         'Fordon i flödet', pollCount === null ? '–' : pollCount),
    pill(s.has_static_key ? 'ok' : 'err', 'Statisk nyckel', s.has_static_key ? 'OK' : 'SAKNAS'),
    pill(s.has_rt_key ? 'ok' : 'err', 'RT-nyckel', s.has_rt_key ? 'OK' : 'SAKNAS'),
  ];

  if (s.gtfs_error) {
    pills.push(pill('err', 'GTFS-fel', esc(s.gtfs_error)));
  }
  if (s.last_rt_error) {
    pills.push(pill('err', 'RT-fel', esc(s.last_rt_error.slice(0, 60))));
  }

  const wrap = document.createElement('div');
  wrap.id = 'sysstatus';
  wrap.innerHTML = pills.join('');
  body.appendChild(wrap);

  if (s.last_vehicle_update) {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:8px;color:#556;font-size:11px';
    note.textContent = `Senaste RT-uppdatering: ${fmtTs(s.last_vehicle_update)} (${fmtAge(s.last_vehicle_update)} sedan)`;
    body.appendChild(note);
  }

  return card;
}

function pill(state, label, val) {
  return `<div class="spill ${state}"><div class="dot"></div><span class="label">${label}</span><span class="val">${val}</span></div>`;
}

// ── TV train positions ─────────────────────────────────────────────

function buildTvPositions(d) {
  const card = makeCard('Tåg inom radien (Trafikverket)');
  const hdr = card.querySelector('.card-header');
  const body = card.querySelector('.card-body');

  if (!d || d.error) {
    body.innerHTML = '<span class="txt-muted-sm">Debug-endpoints är inaktiverade (ENABLE_DEBUG_ENDPOINTS=false)</span>';
    return card;
  }

  const cfg = d.config || {};
  const trains = d.trains || [];
  const updateAgeS = d.last_update ? Math.round(Date.now() / 1000 - d.last_update) : null;
  const sseState = d.sse_state || 'disconnected';
  const sseColor = sseState === 'connected' ? '#4caf50' : sseState === 'reconnecting' ? '#f5a623' : '#f05050';

  hdr.querySelector('.meta').textContent =
    `${d.filtered_count} inom radien / ${d.raw_count} från API · uppdaterad ${updateAgeS != null ? updateAgeS + 's sedan' : '–'}`;

  // API key warning
  if (!d.api_key_set) {
    const noKey = document.createElement('div');
    noKey.style.cssText = 'color:#f05050;font-weight:600;font-size:12px;margin-bottom:8px;background:#2a1010;padding:6px 10px;border-radius:4px';
    noKey.textContent = '⚠ TRAFIKVERKET_API_KEY är inte satt — ingen data hämtas';
    body.appendChild(noKey);
  }

  // SSE connection state badge (built with DOM to avoid inline styles)
  const sseBadge = document.createElement('div');
  sseBadge.className = 'sse-badge';
  const dot = document.createElement('span');
  dot.className = 'sse-dot';
  dot.style.background = sseColor;
  sseBadge.appendChild(dot);
  const label = document.createElement('span');
  label.innerHTML = 'SSE-ström: ';
  const strong = document.createElement('strong');
  strong.textContent = sseState;
  strong.style.color = sseColor;
  label.appendChild(strong);
  sseBadge.appendChild(label);
  body.appendChild(sseBadge);

  // Config info row
  const cfgRow = document.createElement('div');
  cfgRow.style.cssText = 'color:#778;font-size:11px;margin-bottom:10px';
  cfgRow.textContent =
    `Centrum: ${cfg.center_lat}, ${cfg.center_lon} · Radie: ${cfg.radius_km} km`;
  body.appendChild(cfgRow);

  if (d.last_error) {
    const err = document.createElement('div');
    err.style.cssText = 'color:#f05050;font-size:12px;margin-bottom:8px;font-family:monospace;background:#2a1010;padding:6px 10px;border-radius:4px';
    err.textContent = 'Fel: ' + d.last_error;
    body.appendChild(err);
  }

  // Operator summary pills
  const opCounts = d.operator_counts || {};
  if (Object.keys(opCounts).length > 0) {
    const opWrap = document.createElement('div');
    opWrap.className = 'tv-op-pills';
    for (const [op, cnt] of Object.entries(opCounts)) {
      const color = opColor(op);
      const pill = document.createElement('div');
      pill.className = 'tv-op-pill';
      const badge = document.createElement('span');
      badge.className = 'op-badge';
      badge.style.background = '#' + color;
      badge.style.color = '#fff';
      badge.textContent = op;
      const countStrong = document.createElement('strong');
      countStrong.textContent = cnt;
      const dimSpan = document.createElement('span');
      dimSpan.className = 'txt-dim';
      dimSpan.textContent = ' i rå-svaret';
      pill.appendChild(badge);
      pill.appendChild(document.createTextNode('\u00a0'));
      pill.appendChild(countStrong);
      pill.appendChild(dimSpan);
      opWrap.appendChild(pill);
    }
    body.appendChild(opWrap);
  }

  if (trains.length === 0) {
    body.innerHTML += '<div class="no-vehicles">Inga tåg inom radien just nu</div>';
    return card;
  }

  body.style.padding = '0';
  cfgRow.style.cssText += ';padding:10px 14px 0';
  const errEl = body.querySelector('[style*="2a1010"]');
  if (errEl) errEl.style.margin = '0 14px 8px';
  const opWrapEl = body.querySelector('.tv-op-pills');
  if (opWrapEl) opWrapEl.style.cssText += ';padding:0 14px 10px';

  const table = document.createElement('table');
  table.className = 'tv-trains-table';
  table.innerHTML = `<thead><tr>
    <th>Tågnr</th>
    <th>Operatör</th>
    <th>Lat</th>
    <th>Lon</th>
    <th>Kurs</th>
    <th>Hastighet</th>
    <th>Ålder</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');

  for (const t of trains) {
    const color = opColor(t.route_long_name || '');
    const speed = t.speed != null ? Math.round(t.speed * 3.6) + ' km/h' : '–';
    const age = fmtAge(t.timestamp);
    const stale = isStale(t.timestamp);
    const bearing = t.bearing != null ? t.bearing + '°' : '–';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong class="txt-white">${esc(t.label)}</strong></td>
      <td><span class="op-badge" data-bg="${color}"></span></td>
      <td class="td-mono">${t.lat?.toFixed(4)}</td>
      <td class="td-mono">${t.lon?.toFixed(4)}</td>
      <td class="td-muted">${bearing}</td>
      <td class="td-green">${speed}</td>
      <td class="age-cell${stale ? ' stale' : ''}">${age} sedan</td>`;
    // Set op-badge text and color via JS
    const opBadge = tr.querySelector('.op-badge[data-bg]');
    if (opBadge) {
      opBadge.style.background = '#' + color;
      opBadge.style.color = '#fff';
      opBadge.textContent = esc(t.route_long_name || '–');
      delete opBadge.dataset.bg;
    }
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  body.appendChild(table);
  return card;
}

function opColor(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('mälartåg')) return '005B99';
  if (n.includes('sj'))       return 'D4004C';
  if (n.includes('arriva') || n.includes('bergslagen') || n.includes('tib')) return 'E87722';
  if (n.includes('snälltåget')) return '1A1A1A';
  if (n.includes('mtr')) return '007BC0';
  return '555555';
}

// ── Configured lines table ─────────────────────────────────────────

function buildLinesTable(byLine) {
  const allConfigured = typeof LINE_CONFIG !== 'undefined'
    ? { ...LINE_CONFIG }
    : { linjer: [...(typeof ALLOWED_LINE_NUMBERS !== 'undefined' ? ALLOWED_LINE_NUMBERS : [])] };

  let totalLines = 0, activeLines = 0;
  for (const group of Object.values(allConfigured)) {
    for (const ln of group) {
      totalLines++;
      if ((byLine[ln] || []).length > 0) activeLines++;
    }
  }

  const card = makeCard('Konfigurerade linjer');
  const hdr = card.querySelector('.card-header');
  const meta = hdr.querySelector('.meta');
  meta.textContent = `${activeLines} aktiva / ${totalLines} konfigurerade`;

  const body = card.querySelector('.card-body');
  body.style.padding = '0';

  // summary bar
  const sumWrap = document.createElement('div');
  sumWrap.style.cssText = 'padding:10px 14px;border-bottom:1px solid #2a2d3d;';
  sumWrap.id = 'lines-summary';
  const inactiveCount = totalLines - activeLines;
  const totalVehicles = Object.values(byLine).reduce((s, vs) => s + vs.length, 0);
  sumWrap.innerHTML = `
    <div class="sum-pill"><strong>${totalLines}</strong> linjer totalt</div>
    <div class="sum-pill sum-pill-active"><strong>${activeLines}</strong> aktiva just nu</div>
    <div class="sum-pill${inactiveCount > 0 ? ' sum-pill-inactive' : ''}"><strong>${inactiveCount}</strong> utan fordon</div>
    <div class="sum-pill"><strong>${totalVehicles}</strong> fordon totalt (konfigurerade)</div>
  `;
  body.appendChild(sumWrap);

  const table = document.createElement('table');
  table.className = 'lines-table';
  table.innerHTML = `<thead><tr>
    <th>Linje</th>
    <th>Namn</th>
    <th>Fordon</th>
    <th>Fordon detaljer</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');

  for (const [groupName, lineNums] of Object.entries(allConfigured)) {
    // group header
    const ghTr = document.createElement('tr');
    ghTr.className = 'category-header';
    ghTr.innerHTML = `<td colspan="4">${esc(groupName)}</td>`;
    tbody.appendChild(ghTr);

    for (const ln of lineNums) {
      const vehs = byLine[ln] || [];
      const tr = document.createElement('tr');

      // badge
      const tdBadge = document.createElement('td');
      tdBadge.innerHTML = badgeHtml(ln);

      // name – pick from first vehicle or blank
      const tdName = document.createElement('td');
      const longName = vehs.length > 0
        ? (vehs[0].route_long_name || '–')
        : '–';
      tdName.style.color = '#aab';
      tdName.textContent = longName;

      // count
      const tdCount = document.createElement('td');
      tdCount.style.whiteSpace = 'nowrap';
      if (vehs.length > 0) {
        tdCount.innerHTML = `<span class="count-active">${vehs.length}</span>`;
      } else {
        tdCount.innerHTML = `<span class="count-zero">0</span>`;
      }

      // vehicles detail
      const tdDetail = document.createElement('td');
      if (vehs.length === 0) {
        tdDetail.innerHTML = '<span class="no-vehicles">Inga aktiva fordon</span>';
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'vehicles-cell';
        for (const v of vehs) {
          const speed = fmtSpeed(v.speed);
          const age = fmtAge(v.timestamp);
          const stale = isStale(v.timestamp);
          const isOxyfi = !(v.vehicle_id || '').startsWith('tv_');
          const rsId = isOxyfi ? (v.vehicle_id || '').split('.')[0] : null;
          const tvNum = v.tv_service_number
                     || (v.label && v.label !== rsId ? v.label : null);
          wrap.innerHTML += `
            <div class="veh-row">
              <span class="veh-id">${esc(isOxyfi ? (rsId || v.vehicle_id) : v.vehicle_id)}</span>
              ${tvNum ? `<span class="veh-tv-num">${esc(tvNum)}</span>` : ''}
              <span class="veh-dest">${esc(v.trip_headsign || '?')}</span>
              <span class="veh-status">${esc(v.current_status || '')}</span>
              ${speed ? `<span class="veh-speed">${speed}</span>` : ''}
              <span class="veh-age${stale ? ' stale' : ''}">${age} sedan</span>
            </div>`;
        }
        tdDetail.appendChild(wrap);
      }

      tr.append(tdBadge, tdName, tdCount, tdDetail);
      tbody.appendChild(tr);
    }
  }

  table.appendChild(tbody);
  body.appendChild(table);
  return card;
}

// ── Unconfigured vehicles ──────────────────────────────────────────

function buildUnconfigured(byLine) {
  const allowed = typeof ALLOWED_LINE_NUMBERS !== 'undefined' ? ALLOWED_LINE_NUMBERS : new Set();
  const unknown = [];
  for (const [name, vehs] of Object.entries(byLine)) {
    if (name === '__UNKNOWN__') continue;
    if (vehs.some(v => v.vehicle_type === 'train')) continue;
    if (!allowed.has(name)) unknown.push({ name, vehs });
  }
  const noRouteVehs = (byLine['__UNKNOWN__'] || []).filter(v => v.vehicle_type !== 'train');

  const card = makeCard('Okonfigurerade fordon');
  const hdr = card.querySelector('.card-header');
  const meta = hdr.querySelector('.meta');
  meta.textContent = `${unknown.length} okända linjer · ${noRouteVehs.length} fordon utan rutt`;

  const body = card.querySelector('.card-body');

  if (unknown.length === 0 && noRouteVehs.length === 0) {
    body.innerHTML = '<span class="txt-success">Inga okonfigurerade fordon – allt matchar LINE_CONFIG ✓</span>';
    return card;
  }

  if (unknown.length > 0) {
    const h = document.createElement('div');
    h.style.cssText = 'color:#f0a030;font-weight:600;margin-bottom:8px;font-size:12px';
    h.textContent = 'Linjer i trafik men ej i LINE_CONFIG:';
    body.appendChild(h);

    const table = document.createElement('table');
    table.className = 'uncfg-table';
    table.innerHTML = '<thead><tr><th>Linje</th><th>Fordon</th><th>Detaljer</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const { name, vehs } of unknown.sort((a, b) => a.name.localeCompare(b.name))) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${badgeHtml(name)}</td>
        <td>${vehs.length}</td>
        <td class="txt-muted-aab">${vehs.map(v => esc(v.route_long_name || v.route_id || '–')).filter((v,i,a) => a.indexOf(v) === i).join(' / ')}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  if (noRouteVehs.length > 0) {
    const h = document.createElement('div');
    h.style.cssText = 'color:#f05050;font-weight:600;margin:12px 0 8px;font-size:12px';
    h.textContent = `${noRouteVehs.length} fordon saknar helt rutt-information:`;
    body.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'sample-list';
    for (const v of noRouteVehs.slice(0, 10)) {
      ul.innerHTML += `<li>${esc(v.vehicle_id)} · trip_id: ${esc(v.trip_id || '–')} · ${esc(v.current_status || '')}</li>`;
    }
    if (noRouteVehs.length > 10) {
      ul.innerHTML += `<li class="txt-dim">… och ${noRouteVehs.length - 10} till</li>`;
    }
    body.appendChild(ul);
  }

  return card;
}

// ── RT matching stats ──────────────────────────────────────────────

function buildMatching(m, vehicles) {
  const card = makeCard('RT-matchning & debug');
  const body = card.querySelector('.card-body');

  if (!m || m.error) {
    body.innerHTML = '<span class="txt-muted-sm">Debug-endpoints är inaktiverade (ENABLE_DEBUG_ENDPOINTS=false)</span>';
    return card;
  }

  const withPct = m.total_vehicles ? Math.round(100 * m.with_route / m.total_vehicles) : 0;
  const tripPct = m.total_vehicles ? Math.round(100 * m.trip_id_match_ok / m.total_vehicles) : 0;

  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.innerHTML = `
    <div class="stat-box"><div class="sval">${m.total_vehicles}</div><div class="slabel">Fordon totalt (RT)</div></div>
    <div class="stat-box ${withPct >= 90 ? 'good' : withPct >= 70 ? 'warn' : 'bad'}">
      <div class="sval">${m.with_route} <small class="pct-small">(${withPct}%)</small></div>
      <div class="slabel">Med rutt-info</div>
    </div>
    <div class="stat-box ${m.without_route === 0 ? 'good' : 'warn'}">
      <div class="sval">${m.without_route}</div>
      <div class="slabel">Utan rutt-info</div>
    </div>
    <div class="stat-box ${tripPct >= 90 ? 'good' : tripPct >= 70 ? 'warn' : 'bad'}">
      <div class="sval">${m.trip_id_match_ok} <small class="pct-small">(${tripPct}%)</small></div>
      <div class="slabel">Trip-ID matchade</div>
    </div>
    <div class="stat-box ${m.trip_id_match_fail === 0 ? 'good' : 'warn'}">
      <div class="sval">${m.trip_id_match_fail}</div>
      <div class="slabel">Trip-ID misslyckades</div>
    </div>
    <div class="stat-box">
      <div class="sval">${m.total_trip_update_mappings}</div>
      <div class="slabel">TripUpdate-mappningar</div>
    </div>
  `;
  body.appendChild(grid);

  // Sample: vehicles without route
  if (m.sample_without_route && m.sample_without_route.length > 0) {
    const h = document.createElement('div');
    h.style.cssText = 'color:#f0a030;font-weight:600;margin:14px 0 6px;font-size:12px';
    h.textContent = 'Fordon utan rutt-ID (med deras trip_id från flödet)';
    body.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'sample-list';
    for (const item of m.sample_without_route) {
      const vid = typeof item === 'object' ? item.vehicle_id : item;
      const tripId = typeof item === 'object' ? (item.trip_id || '–') : '–';
      ul.innerHTML += `<li>vehicle <b>${esc(vid)}</b> · trip_id: <span class="txt-warn">${esc(tripId)}</span></li>`;
    }
    body.appendChild(ul);
  }

  // Sample: trip update mappings
  if (m.sample_trip_update_mappings && m.sample_trip_update_mappings.length > 0) {
    const h = document.createElement('div');
    h.style.cssText = 'color:#7eb8f7;font-weight:600;margin:14px 0 6px;font-size:12px';
    h.textContent = 'Exempel: TripUpdate-mappningar';
    body.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'sample-list';
    for (const s of m.sample_trip_update_mappings) {
      ul.innerHTML += `<li>vehicle ${esc(s.vehicle_id)} → trip ${esc(s.trip_id)} → linje ${esc(s.route_short_name || '–')} "${esc(s.route_long_name || '')}"</li>`;
    }
    body.appendChild(ul);
  }

  return card;
}

// ── RT feed raw debug ─────────────────────────────────────────────

function buildRtFeedCard(f) {
  const card = makeCard('RT-flöde rådata');
  const hdr = card.querySelector('.card-header');
  hdr.querySelector('.meta').textContent = 'cachad data – ingen extra Trafiklab-förfrågan';
  const body = card.querySelector('.card-body');

  if (!f || f.error) {
    body.innerHTML = '<span class="txt-muted-sm">Debug-endpoints är inaktiverade (ENABLE_DEBUG_ENDPOINTS=false)</span>';
    return card;
  }

  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.innerHTML = `
    <div class="stat-box ${(f.cached_vehicles ?? 0) > 0 ? 'good' : 'warn'}">
      <div class="sval">${f.cached_vehicles ?? '–'}</div><div class="slabel">Fordon i cache</div>
    </div>
    <div class="stat-box">
      <div class="sval">${f.trip_update_mappings ?? '–'}</div><div class="slabel">TripUpdate-mappningar</div>
    </div>
    <div class="stat-box ${(f.last_poll_count ?? 0) > 0 ? 'good' : 'warn'}">
      <div class="sval">${f.last_poll_count ?? '–'}</div><div class="slabel">Fordon vid senaste poll</div>
    </div>
  `;
  body.appendChild(grid);

  if (f.last_error) {
    const err = document.createElement('div');
    err.style.cssText = 'color:#f05050;margin:10px 0 4px;font-size:12px;font-weight:600';
    err.textContent = 'Senaste RT-fel:';
    body.appendChild(err);
    const errMsg = document.createElement('div');
    errMsg.style.cssText = 'color:#f07070;font-size:11px;font-family:monospace;background:#2a1010;padding:6px 10px;border-radius:4px';
    errMsg.textContent = f.last_error;
    body.appendChild(errMsg);
  }

  if (f.sample_vehicles && f.sample_vehicles.length > 0) {
    const h = document.createElement('div');
    h.style.cssText = 'color:#7eb8f7;font-weight:600;margin:14px 0 6px;font-size:12px';
    h.textContent = 'Exempelfordon (cache):';
    body.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'sample-list';
    for (const v of f.sample_vehicles) {
      ul.innerHTML += `<li>vehicle_id:<b>${esc(v.vehicle_id)}</b>  lat:${v.lat?.toFixed(4)}  trip_id:<span class="txt-warn">${esc(v.trip_id||'–')}</span>  route_id:<span class="txt-info">${esc(v.route_id||'–')}</span></li>`;
    }
    body.appendChild(ul);
  }

  return card;
}

// ── Util ───────────────────────────────────────────────────────────

function makeCard(title) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-header">
      <h2>${esc(title)}</h2>
      <span class="meta"></span>
    </div>
    <div class="card-body"></div>`;
  return card;
}

function updateClock() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('sv-SE');
}

// ── Main loop ──────────────────────────────────────────────────────

async function refresh() {
  try {
    const data = await fetchAll();
    render(data);
  } catch (e) {
    document.getElementById('page').innerHTML =
      `<div class="txt-error" style="padding:20px">Fel: ${esc(String(e))}</div>`;
  }
}

document.getElementById('refresh-btn').addEventListener('click', refresh);

setInterval(updateClock, 1000);
updateClock();

refresh();
_refreshTimer = setInterval(refresh, 10000);
