/**
 * stadstrafiken.js - live schematic map of the city lines.
 * Map model comes from /api/schematic (edited in schematic-editor.html).
 * Buses are placed stop-to-stop on the schematic edges and glide between updates.
 */

import { el, renderMap, edgeLinePoints, pointAt, subPath, polyLength, lineSort, modelBounds } from "./modules/schematicRender.js";
import { attachPanZoom } from "./modules/svgPanZoom.js";

const KIOSK = new URLSearchParams(location.search).has("kiosk");
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const MAX_OFF_ROUTE_M = 400;

let model = null;
let stopNode = {};          // stop_id -> node id
let lineEdges = {};         // line -> [edge index]
let edgePts = {};           // "edgeIdx|line" -> polyline
let hiddenLines = new Set();
let lastVehicles = [];
const vstate = {};          // vehicle_id -> {loc, x, y, angle, anim, g, data}
let lastMsgAt = 0, msgInterval = 5000;
let pz = null;

const $ = (id) => document.getElementById(id);
const gVehicles = $("g-vehicles");

// --- Geo helpers -------------------------------------------------------------

function toMeters(lat, lon, lat0, lon0) {
    return [(lon - lon0) * Math.cos(lat0 * Math.PI / 180) * 111320, (lat - lat0) * 110540];
}

function bearingDeg(a, b) {
    const [x, y] = toMeters(b.lat, b.lon, a.lat, a.lon);
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

// Project vehicle on the straight segment between the two stops of an edge.
function projectOnEdge(v, edge) {
    const a = model.nodes[edge.a], b = model.nodes[edge.b];
    const [bx, by] = toMeters(b.lat, b.lon, a.lat, a.lon);
    const [px, py] = toMeters(v.lat, v.lon, a.lat, a.lon);
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    return { t, dist: Math.hypot(px - t * bx, py - t * by) };
}

// --- Vehicle placement ---------------------------------------------------------

function locate(v, prev) {
    const cands = lineEdges[v.route_short_name];
    if (!cands || v.lat == null || v.lon == null) return null;
    const curNode = stopNode[v.current_stop_id];

    let best = null;
    for (const idx of cands) {
        const edge = model.edges[idx];
        const p = projectOnEdge(v, edge);
        const incident = curNode && (edge.a === curNode || edge.b === curNode);
        // Prefer edges ending at the stop the vehicle reports, then the closest edge
        const score = p.dist - (incident ? MAX_OFF_ROUTE_M : 0);
        if (p.dist <= MAX_OFF_ROUTE_M && (!best || score < best.score)) best = { idx, t: p.t, score, incident };
    }
    if (!best) return null;

    const edge = model.edges[best.idx];
    let head;
    if (best.incident && v.current_status === "Vid hållplats") {
        best.t = curNode === edge.a ? 0 : 1;
        head = prev && prev.idx === best.idx ? prev.head : (curNode === edge.a ? "b" : "a");
    } else if (best.incident) {
        head = curNode === edge.a ? "a" : "b";
    } else if (v.bearing != null) {
        const diff = Math.abs(((v.bearing - bearingDeg(model.nodes[edge.a], model.nodes[edge.b])) + 540) % 360 - 180);
        head = diff < 90 ? "b" : "a";
    } else if (prev && prev.idx === best.idx) {
        head = best.t >= prev.t ? "b" : "a";
    } else {
        head = "b";
    }
    return { idx: best.idx, line: v.route_short_name, t: best.t, head };
}

function linePts(idx, line) {
    const key = idx + "|" + line;
    if (!edgePts[key]) edgePts[key] = edgeLinePoints(model, model.edges[idx], line);
    return edgePts[key];
}

function sharedNode(e1, e2) {
    if (e1.a === e2.a || e1.a === e2.b) return e1.a;
    if (e1.b === e2.a || e1.b === e2.b) return e1.b;
    return null;
}

// Path on the schematic from the old to the new location (null = jump).
function travelPath(from, to) {
    if (from.line !== to.line) return null;
    const p1 = linePts(from.idx, from.line), p2 = linePts(to.idx, to.line);
    if (from.idx === to.idx) return subPath(p1, from.t, to.t);
    const e1 = model.edges[from.idx], e2 = model.edges[to.idx];
    const n = sharedNode(e1, e2);
    if (!n) return null;
    const a = subPath(p1, from.t, n === e1.a ? 0 : 1);
    const b = subPath(p2, n === e2.a ? 0 : 1, to.t);
    return a.concat(b);
}

function restAngle(loc) {
    const p = pointAt(linePts(loc.idx, loc.line), loc.t);
    return loc.head === "b" ? p.angle : p.angle + 180;
}

// --- Vehicle drawing -----------------------------------------------------------

function delayColor(v) {
    const d = v.delay_seconds;
    if (d == null || d <= 60) return "#ffffff";
    if (d <= 300) return "#FFD600";
    return "#F44336";
}

function makeVehicle(v) {
    const c = model.lines[v.route_short_name] || { color: "#555", text: "#fff" };
    const g = el("g", { class: "vehicle" }, gVehicles);
    const body = el("g", {}, g);
    el("path", { d: "M 14,-8 L 27,0 L 14,8 Z", fill: c.color, stroke: "#ffffff", "stroke-width": 2.5, "stroke-linejoin": "round" }, body);
    const ring = el("circle", { r: 16, fill: c.color, stroke: "#ffffff", "stroke-width": 3.5 }, body);
    const text = el("text", {
        "text-anchor": "middle", "dominant-baseline": "central", "font-size": 17, "font-weight": 800,
        "font-family": "Helvetica, Arial, sans-serif", fill: c.text || "#ffffff",
    }, g);
    text.textContent = v.route_short_name;
    const title = el("title", {}, g);
    g.addEventListener("click", (e) => { e.stopPropagation(); showVehicle(g._vid); });
    return { g, body, ring, title };
}

// Keep vehicles readable when zoomed out: about 7-11 px radius on screen
function vehicleScale() {
    const px = Math.min(11, Math.max(7, window.innerWidth / 50));
    return pz ? Math.max(1, px / (16 * pz.view.s)) : 1;
}

function placeVehicle(s) {
    const k = vehicleScale();
    s.els.g.setAttribute("transform", `translate(${s.x.toFixed(1)},${s.y.toFixed(1)}) scale(${k.toFixed(3)})`);
    s.els.body.setAttribute("transform", `rotate(${s.angle.toFixed(1)})`);
}

function updateVehicles(vehicles) {
    lastVehicles = vehicles;
    const now = performance.now();
    if (lastMsgAt) msgInterval = Math.max(2000, Math.min(15000, now - lastMsgAt));
    lastMsgAt = now;

    const seen = new Set();
    for (const v of vehicles) {
        const id = v.vehicle_id || v.id;
        if (!id || !model.lines[v.route_short_name]) continue;
        const prev = vstate[id];
        if (hiddenLines.has(v.route_short_name)) continue;
        const loc = locate(v, prev && prev.loc);
        if (!loc) continue;
        seen.add(id);

        const target = pointAt(linePts(loc.idx, loc.line), loc.t);
        const angle = restAngle(loc);
        if (!prev || prev.loc.line !== loc.line) {
            if (prev) prev.els.g.remove();
            const s = vstate[id] = { loc, x: target.x, y: target.y, angle, anim: null, els: makeVehicle(v) };
            s.els.g._vid = id;
            placeVehicle(s);
        } else {
            const path = travelPath(prev.loc, loc);
            prev.anim = path && polyLength(path) > 0.5 && !REDUCED_MOTION
                ? { path, start: now, dur: msgInterval * 0.85, endAngle: angle }
                : null;
            if (!prev.anim) { prev.x = target.x; prev.y = target.y; prev.angle = angle; placeVehicle(prev); }
            prev.loc = loc;
        }
        const s = vstate[id];
        s.data = v;
        s.els.ring.setAttribute("stroke", delayColor(v));
        s.els.title.textContent = `Linje ${v.route_short_name}${v.trip_headsign ? " mot " + v.trip_headsign : ""}`;
    }
    for (const id of Object.keys(vstate)) {
        if (!seen.has(id)) { vstate[id].els.g.remove(); delete vstate[id]; }
    }
    updateVehicleCounts(vehicles);
    $("last-update").textContent = "Uppdaterad " + new Date().toLocaleTimeString("sv-SE");
    startAnim();
}

let animId = null;
function startAnim() {
    if (animId) return;
    const frame = (ts) => {
        let active = false;
        for (const s of Object.values(vstate)) {
            if (!s.anim) continue;
            const raw = Math.min(1, (ts - s.anim.start) / s.anim.dur);
            const t = raw < 0.5 ? 2 * raw * raw : -1 + (4 - 2 * raw) * raw;
            const p = pointAt(s.anim.path, t);
            s.x = p.x; s.y = p.y;
            s.angle = raw < 1 ? p.angle : s.anim.endAngle;
            placeVehicle(s);
            if (raw < 1) active = true; else s.anim = null;
        }
        animId = active ? requestAnimationFrame(frame) : null;
    };
    animId = requestAnimationFrame(frame);
}

function updateVehicleCounts(vehicles) {
    const byLine = {};
    for (const v of vehicles) {
        if (model.lines[v.route_short_name]) byLine[v.route_short_name] = (byLine[v.route_short_name] || 0) + 1;
    }
    const box = $("vehicle-counts");
    box.replaceChildren();
    for (const ln of Object.keys(model.lines).sort(lineSort)) {
        if (!byLine[ln]) continue;
        const item = document.createElement("span");
        item.className = "vc-item";
        const dot = document.createElement("span");
        dot.className = "vc-dot";
        dot.style.background = model.lines[ln].color;
        item.append(dot, String(byLine[ln]));
        box.appendChild(item);
    }
}

// --- Panels --------------------------------------------------------------------

function lineBadge(cls, ln) {
    const c = model.lines[ln] || { color: "#555", text: "#fff" };
    const b = document.createElement("span");
    b.className = cls;
    b.style.background = c.color;
    b.style.color = c.text || "#fff";
    b.textContent = ln;
    return b;
}

function openPanel(title) {
    $("dep-stop-name").textContent = title;
    $("dep-lines").replaceChildren();
    $("dep-content").replaceChildren();
    $("dep-panel").classList.add("open");
}

function msg(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
}

async function showStop(nodeId) {
    const node = model.nodes[nodeId];
    openPanel(node.name);
    const lines = new Set();
    for (const e of model.edges) if (e.a === nodeId || e.b === nodeId) e.lines.forEach(l => lines.add(l));
    [...lines].sort(lineSort).forEach(l => $("dep-lines").appendChild(lineBadge("dep-line-badge", l)));
    const content = $("dep-content");
    content.appendChild(msg("loading-deps", "Hämtar avgångar..."));

    // A parent station id returns departures for all its quays
    const ids = node.stop_ids.includes(nodeId) ? node.stop_ids : [nodeId];
    try {
        const results = await Promise.all(ids.map(id => fetch(`/api/departures/${encodeURIComponent(id)}?limit=15`).then(r => r.json())));
        const deps = results.flatMap(r => r.departures || [])
            .filter(d => model.lines[d.route_short_name])
            .sort((a, b) => a.departure_time - b.departure_time);
        content.replaceChildren();
        if (!deps.length) { content.appendChild(msg("no-deps", "Inga avgångar hittades just nu.")); return; }

        const grouped = {};
        for (const d of deps) (grouped[d.headsign || "Okänd"] ||= []).push(d);
        const now = Date.now() / 1000;
        for (const [dest, list] of Object.entries(grouped)) {
            const sec = document.createElement("div");
            sec.className = "dep-direction";
            sec.appendChild(msg("dep-direction-label", dest));
            for (const d of list.slice(0, 5)) {
                const row = document.createElement("div");
                row.className = "dep-row";
                const mins = Math.max(0, Math.round((d.departure_time - now) / 60));
                let cls = "dep-time";
                if (d.canceled) cls += " late";
                else if (mins <= 2) cls += " soon";
                else if (d.is_realtime) cls += " realtime";
                const time = d.canceled ? "Inställd" : mins === 0 ? "Nu" : mins + " min";
                const delay = d.delay_minutes > 0 ? ` (+${d.delay_minutes})` : "";
                row.append(lineBadge("dep-line", d.route_short_name), msg("dep-dest", d.headsign || "-"), msg(cls, time + delay));
                sec.appendChild(row);
            }
            content.appendChild(sec);
        }
    } catch {
        content.replaceChildren(msg("no-deps", "Fel vid hämtning av avgångar."));
    }
}

function showVehicle(id) {
    const s = vstate[id];
    if (!s) return;
    const v = s.data;
    openPanel(v.trip_headsign ? `Mot ${v.trip_headsign}` : `Linje ${v.route_short_name}`);
    $("dep-lines").appendChild(lineBadge("dep-line-badge", v.route_short_name));
    const sec = document.createElement("div");
    sec.className = "dep-direction";
    const rows = [
        ["Nästa hållplats", v.next_stop_name || "-"],
        ["Status", v.current_status || "-"],
        ["Försening", v.delay_seconds == null ? "Ingen data" : v.delay_seconds <= 60 ? "I tid" : `${Math.round(v.delay_seconds / 60)} min sen`],
        ["Fordon", v.label || v.vehicle_id || "-"],
    ];
    for (const [k, val] of rows) {
        const row = document.createElement("div");
        row.className = "dep-row";
        row.append(msg("dep-dest", k), msg("dep-time", val));
        sec.appendChild(row);
    }
    $("dep-content").appendChild(sec);
}

// --- Line badges ---------------------------------------------------------------

let groups, mapEls;
function drawMap() {
    mapEls = renderMap(model, groups, { hiddenLines, interactive: false });
    for (const [id, c] of Object.entries(mapEls.nodeEls)) {
        if (!KIOSK) c.addEventListener("click", (e) => { e.stopPropagation(); showStop(id); });
    }
}

function buildLineBadges() {
    const box = $("line-badges");
    box.replaceChildren();
    for (const ln of Object.keys(model.lines).sort(lineSort)) {
        const btn = document.createElement("button");
        btn.className = "line-badge";
        btn.style.background = model.lines[ln].color;
        btn.style.color = model.lines[ln].text || "#fff";
        btn.textContent = ln;
        btn.title = `Linje ${ln} - klicka för att dölja`;
        btn.addEventListener("click", () => {
            if (hiddenLines.has(ln)) hiddenLines.delete(ln); else hiddenLines.add(ln);
            btn.classList.toggle("faded", hiddenLines.has(ln));
            drawMap();
            updateVehicles(lastVehicles);
        });
        box.appendChild(btn);
    }
}

// --- Data ----------------------------------------------------------------------

let pollTimer = null;
async function pollVehicles() {
    try {
        const data = await fetch("/api/vehicles").then(r => r.json());
        updateVehicles(data.vehicles || []);
    } catch (e) { console.warn("Vehicle fetch failed:", e); }
}

function connect() {
    const src = new EventSource("/api/stream");
    src.addEventListener("vehicles", (e) => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        updateVehicles(JSON.parse(e.data).vehicles || []);
    });
    src.onerror = () => {
        if (!pollTimer) { pollVehicles(); pollTimer = setInterval(pollVehicles, 10000); }
    };
}

function showErr(text) {
    const bar = $("err-bar");
    bar.textContent = text;
    bar.style.display = "block";
    setTimeout(() => { bar.style.display = "none"; }, 4000);
}

async function init() {
    if (KIOSK) document.body.classList.add("kiosk");
    try {
        const r = await fetch("/api/schematic");
        model = await r.json();
        if (!r.ok) throw new Error(model.error || r.status);
    } catch (e) {
        $("loading-overlay").textContent = "Kunde inte hämta kartan: " + e.message;
        return;
    }

    for (const [id, n] of Object.entries(model.nodes)) for (const sid of n.stop_ids) stopNode[sid] = id;
    model.edges.forEach((e, i) => e.lines.forEach(l => (lineEdges[l] ||= []).push(i)));

    const bounds = modelBounds(model);
    const paper = $("paper");
    paper.setAttribute("x", bounds.x);
    paper.setAttribute("y", bounds.y);
    paper.setAttribute("width", bounds.w);
    paper.setAttribute("height", bounds.h);
    groups = { edges: $("g-edges"), nodes: $("g-nodes"), labels: $("g-labels") };
    drawMap();
    buildLineBadges();

    const svg = $("main-svg"), gPan = $("g-pan");
    const onZoom = () => Object.values(vstate).forEach(placeVehicle);
    if (KIOSK) {
        pz = { view: { x: 0, y: 0, s: 1 } };
        const fitKiosk = () => {
            const r = svg.getBoundingClientRect();
            const v = pz.view;
            v.s = Math.min(r.width / bounds.w, r.height / bounds.h);
            v.x = (r.width - bounds.w * v.s) / 2 - bounds.x * v.s;
            v.y = (r.height - bounds.h * v.s) / 2 - bounds.y * v.s;
            gPan.setAttribute("transform", `translate(${v.x},${v.y}) scale(${v.s})`);
            onZoom();
        };
        window.addEventListener("resize", fitKiosk);
        fitKiosk();
    } else {
        pz = attachPanZoom(svg, gPan, { onChange: onZoom });
        const fit = () => pz.fit(bounds.x, bounds.y, bounds.w, bounds.h);
        fit();
        $("btn-fit").addEventListener("click", fit);
    }

    $("loading-overlay").style.display = "none";
    connect();
}

$("btn-labels").addEventListener("click", () => {
    const hidden = $("g-labels").classList.toggle("hidden");
    $("btn-labels").textContent = hidden ? "Visa namn" : "Dölj namn";
});
$("dep-close").addEventListener("click", () => $("dep-panel").classList.remove("open"));
$("dep-panel").addEventListener("click", e => e.stopPropagation());
$("main-svg").addEventListener("click", () => $("dep-panel").classList.remove("open"));

init().catch(e => showErr(String(e)));
