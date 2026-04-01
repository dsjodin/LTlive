/**
 * admin.js — LTlive Admin interface logic.
 *
 * Communicates with /api/admin/config to read/write the centralised
 * site configuration stored as a JSON file on the backend.
 */

let _apiKey = sessionStorage.getItem("admin_api_key") || "";
let _config = null;

// ── Helpers ─────────────────────────────────────────────────────────

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function showToast(msg, type = "success") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = type;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ""; }, 4000);
}

async function api(method, path, body) {
    const opts = {
        method,
        headers: { "Authorization": `Bearer ${_apiKey}`, "Content-Type": "application/json" },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(path, opts);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
}

// ── Auth ────────────────────────────────────────────────────────────

async function tryLogin() {
    _apiKey = $("#api-key-input").value.trim();
    if (!_apiKey) { showToast("Ange en API-nyckel", "error"); return; }
    try {
        _config = await api("GET", "/api/admin/config");
        sessionStorage.setItem("admin_api_key", _apiKey);
        $("#auth-status").textContent = "Inloggad";
        $("#auth-status").style.color = "var(--success)";
        $("#page").classList.remove("locked");
        $("#save-btn").disabled = false;
        $("#reload-gtfs-btn").disabled = false;
        populateForm();
    } catch (err) {
        showToast(err.message, "error");
        $("#auth-status").textContent = "Misslyckades";
        $("#auth-status").style.color = "var(--danger)";
    }
}

// ── Populate form from config ───────────────────────────────────────

function populateForm() {
    if (!_config) return;
    const c = _config;

    // Identity
    $("#site-name").value = c.site_name || "";
    $("#operator").value = c.operator || "";

    // Map
    $("#map-lat").value = c.map?.center_lat ?? "";
    $("#map-lon").value = c.map?.center_lon ?? "";
    $("#map-zoom").value = c.map?.default_zoom ?? 13;
    $("#tv-lat").value = c.map?.tv_position_center_lat ?? "";
    $("#tv-lon").value = c.map?.tv_position_center_lon ?? "";
    $("#tv-radius").value = c.map?.tv_position_radius_km ?? 150;

    // Lines
    populateTagInput("lines-stads", c.lines?.stadstrafiken || []);
    populateTagInput("lines-lans", c.lines?.lansbuss || []);
    populateTagInput("lines-tag", c.lines?.tag_i_bergslagen || []);

    // Colors
    renderColors(c.line_colors || {});

    // Station presets
    renderPresets(c.station_presets || []);

    // Trafikverket
    renderTvStations(c.trafikverket?.stations || {});
    $("#tv-operators").value = (c.trafikverket?.operators || []).join(", ");
    $("#tv-lookahead").value = c.trafikverket?.lookahead_minutes ?? 120;
    $("#tv-poll").value = c.trafikverket?.poll_seconds ?? 60;

    // Features
    $("#feat-oxyfi").checked = c.features?.oxyfi_enabled ?? true;
    $("#feat-stads").checked = c.features?.stadstrafiken_page ?? true;
    $("#feat-drift").checked = c.features?.driftsplats_overlay ?? true;
    $("#feat-traffic").checked = c.features?.traffic_inference ?? true;
    $("#feat-realtime-off").checked = c.features?.realtime_disabled ?? false;
}

// ── Tag input (lines) ───────────────────────────────────────────────

function populateTagInput(id, items) {
    const wrap = document.getElementById(id);
    // Clear existing tags
    wrap.querySelectorAll(".tag").forEach(t => t.remove());
    let input = wrap.querySelector("input");
    if (!input) {
        input = document.createElement("input");
        input.type = "text";
        input.placeholder = "Skriv och tryck Enter";
        input.addEventListener("keydown", onTagKeydown);
        wrap.appendChild(input);
    }
    items.forEach(v => addTag(wrap, String(v)));
}

function addTag(wrap, value) {
    if (!value.trim()) return;
    const input = wrap.querySelector("input");
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.innerHTML = `${esc(value)}<span class="remove">&times;</span>`;
    tag.querySelector(".remove").addEventListener("click", () => tag.remove());
    wrap.insertBefore(tag, input);
}

function onTagKeydown(e) {
    if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const input = e.target;
        const val = input.value.replace(/,/g, "").trim();
        if (val) addTag(input.parentElement, val);
        input.value = "";
    }
    if (e.key === "Backspace" && !e.target.value) {
        const tags = e.target.parentElement.querySelectorAll(".tag");
        if (tags.length) tags[tags.length - 1].remove();
    }
}

function getTagValues(id) {
    return Array.from(document.getElementById(id).querySelectorAll(".tag"))
        .map(t => t.firstChild.textContent.trim())
        .filter(Boolean);
}

// ── Colors ──────────────────────────────────────────────────────────

function renderColors(colors) {
    const list = $("#colors-list");
    list.innerHTML = "";
    for (const [name, val] of Object.entries(colors)) {
        addColorRow(list, name, val.bg || "555555", val.text || "FFFFFF");
    }
}

function addColorRow(container, name, bg, text) {
    const row = document.createElement("div");
    row.className = "color-row";
    row.innerHTML = `
        <input type="text" class="c-name" value="${esc(name)}" placeholder="Linje" style="width:60px;font-weight:600" />
        <span class="color-preview" style="background:#${esc(bg)}"></span>
        <label style="width:auto;min-width:auto;font-size:12px;color:var(--text2)">bg:</label>
        <input type="text" class="c-bg" value="${esc(bg)}" maxlength="6" />
        <label style="width:auto;min-width:auto;font-size:12px;color:var(--text2)">text:</label>
        <input type="text" class="c-text" value="${esc(text)}" maxlength="6" />
        <span class="remove-btn">&times;</span>
    `;
    row.querySelector(".c-bg").addEventListener("input", (e) => {
        row.querySelector(".color-preview").style.background = "#" + e.target.value;
    });
    row.querySelector(".remove-btn").addEventListener("click", () => row.remove());
    container.appendChild(row);
}

function collectColors() {
    const result = {};
    $$("#colors-list .color-row").forEach(row => {
        const name = row.querySelector(".c-name").value.trim();
        const bg = row.querySelector(".c-bg").value.trim();
        const text = row.querySelector(".c-text").value.trim();
        if (name) result[name] = { bg, text };
    });
    return result;
}

// ── Station presets ─────────────────────────────────────────────────

function renderPresets(presets) {
    const list = $("#presets-list");
    list.innerHTML = "";
    presets.forEach(p => addPresetCard(list, p));
}

function addPresetCard(container, preset) {
    const card = document.createElement("div");
    card.className = "preset-card";
    card.innerHTML = `
        <span class="remove-preset">&times;</span>
        <div class="preset-fields">
            <label>ID</label>
            <input type="text" class="p-id" value="${esc(preset.id || "")}" placeholder="t.ex. orebro-c" />
            <label>Namn</label>
            <input type="text" class="p-label" value="${esc(preset.label || "")}" placeholder="t.ex. Örebro Resecentrum" />
            <label>Söktermer</label>
            <input type="text" class="p-terms" value="${esc((preset.search_terms || []).join(", "))}" placeholder="kommaseparerat" />
            <label>Platssignatur</label>
            <input type="text" class="p-sig" value="${esc(preset.loc_sig || "")}" placeholder="t.ex. Ör" />
        </div>
    `;
    card.querySelector(".remove-preset").addEventListener("click", () => card.remove());
    container.appendChild(card);
}

function collectPresets() {
    return Array.from($$("#presets-list .preset-card")).map(card => ({
        id: card.querySelector(".p-id").value.trim(),
        label: card.querySelector(".p-label").value.trim(),
        search_terms: card.querySelector(".p-terms").value.split(",").map(s => s.trim()).filter(Boolean),
        loc_sig: card.querySelector(".p-sig").value.trim(),
    })).filter(p => p.id);
}

// ── TV stations ─────────────────────────────────────────────────────

function renderTvStations(stations) {
    const tbody = document.querySelector("#tv-stations-table tbody");
    tbody.innerHTML = "";
    for (const [stopId, sig] of Object.entries(stations)) {
        addTvStationRow(tbody, stopId, sig);
    }
}

function addTvStationRow(tbody, stopId, sig) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
        <td><input type="text" class="tv-stop" value="${esc(stopId)}" /></td>
        <td><input type="text" class="tv-sig" value="${esc(sig)}" /></td>
        <td class="remove-btn">&times;</td>
    `;
    tr.querySelector(".remove-btn").addEventListener("click", () => tr.remove());
    tbody.appendChild(tr);
}

function collectTvStations() {
    const result = {};
    $$("#tv-stations-table tbody tr").forEach(tr => {
        const stop = tr.querySelector(".tv-stop").value.trim();
        const sig = tr.querySelector(".tv-sig").value.trim();
        if (stop && sig) result[stop] = sig;
    });
    return result;
}

// ── Collect full config from form ───────────────────────────────────

function collectConfig() {
    return {
        site_name: $("#site-name").value.trim(),
        operator: $("#operator").value.trim(),
        map: {
            center_lat: parseFloat($("#map-lat").value) || 0,
            center_lon: parseFloat($("#map-lon").value) || 0,
            default_zoom: parseInt($("#map-zoom").value) || 13,
            tv_position_center_lat: parseFloat($("#tv-lat").value) || 0,
            tv_position_center_lon: parseFloat($("#tv-lon").value) || 0,
            tv_position_radius_km: parseFloat($("#tv-radius").value) || 150,
        },
        lines: {
            stadstrafiken: getTagValues("lines-stads"),
            lansbuss: getTagValues("lines-lans"),
            tag_i_bergslagen: getTagValues("lines-tag"),
        },
        line_colors: collectColors(),
        station_presets: collectPresets(),
        trafikverket: {
            stations: collectTvStations(),
            operators: $("#tv-operators").value.split(",").map(s => s.trim()).filter(Boolean),
            lookahead_minutes: parseInt($("#tv-lookahead").value) || 120,
            poll_seconds: parseInt($("#tv-poll").value) || 60,
        },
        features: {
            oxyfi_enabled: $("#feat-oxyfi").checked,
            stadstrafiken_page: $("#feat-stads").checked,
            driftsplats_overlay: $("#feat-drift").checked,
            traffic_inference: $("#feat-traffic").checked,
            realtime_disabled: $("#feat-realtime-off").checked,
        },
    };
}

// ── Save ────────────────────────────────────────────────────────────

async function saveConfig() {
    const cfg = collectConfig();
    try {
        $("#save-status").textContent = "Sparar...";
        const result = await api("PUT", "/api/admin/config", cfg);
        _config = result.config;
        showToast("Konfiguration sparad!");
        $("#save-status").textContent = "Sparad " + new Date().toLocaleTimeString("sv-SE");
    } catch (err) {
        showToast("Fel: " + err.message, "error");
        $("#save-status").textContent = "";
    }
}

async function reloadGtfs() {
    try {
        $("#save-status").textContent = "Laddar om GTFS...";
        await api("POST", "/api/admin/restart-gtfs");
        showToast("GTFS-omladdning startad!");
        $("#save-status").textContent = "";
    } catch (err) {
        showToast("Fel: " + err.message, "error");
        $("#save-status").textContent = "";
    }
}

// ── Utilities ───────────────────────────────────────────────────────

function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Init ────────────────────────────────────────────────────────────

function init() {
    // Section collapse/expand
    $$(".section-header").forEach(header => {
        header.addEventListener("click", () => {
            header.classList.toggle("collapsed");
        });
    });

    // Auth
    $("#login-btn").addEventListener("click", tryLogin);
    $("#api-key-input").addEventListener("keydown", e => { if (e.key === "Enter") tryLogin(); });

    // Save / reload
    $("#save-btn").addEventListener("click", saveConfig);
    $("#reload-gtfs-btn").addEventListener("click", reloadGtfs);

    // Add buttons
    $("#add-color").addEventListener("click", () => {
        addColorRow($("#colors-list"), "", "555555", "FFFFFF");
    });
    $("#add-preset").addEventListener("click", () => {
        addPresetCard($("#presets-list"), {});
    });
    $("#add-tv-station").addEventListener("click", () => {
        addTvStationRow(document.querySelector("#tv-stations-table tbody"), "", "");
    });

    // Auto-login if key saved
    if (_apiKey) {
        $("#api-key-input").value = _apiKey;
        tryLogin();
    }
}

init();
