/**
 * schematic-editor.js - edit the schematic map model used by stadstrafiken.html.
 * Loads /api/schematic, saves with PUT /api/admin/schematic (admin key, LAN only).
 */

import { el, NS, renderMap, edgePoints, lineSort, modelBounds, terminalLines } from "./modules/schematicRender.js";
import { attachPanZoom } from "./modules/svgPanZoom.js";
import { fitAffine, ghostMatrix, applyMatrix, invertMatrix, circlesInMap, snapNodesToCircles, SVG_STOP_CIRCLES, IDENTITY } from "./modules/ltKartaSeed.js";

const GRID = 10;
const $ = (id) => document.getElementById(id);

let model = null;
let sel = null;            // {type: "node"|"edge", id}
let calib = null;          // background calibration mode: {pendingNode}
let dirty = false;
const history = [];
const groups = { edges: $("g-edges"), nodes: $("g-nodes"), labels: $("g-labels") };
const overlay = $("g-overlay");
const svg = $("svg");
const pz = attachPanZoom(svg, $("g-pan"), { maxScale: 20 });

// --- Helpers -------------------------------------------------------------------

function status(text, cls = "") {
    const s = $("status");
    s.textContent = text;
    s.className = cls;
}

function setDirty() {
    dirty = true;
    status("Osparade ändringar", "dirty");
}

function snapshot() {
    history.push(JSON.stringify(model));
    if (history.length > 50) history.shift();
}

function snap(v) {
    return $("chk-snap").checked ? Math.round(v / GRID) * GRID : Math.round(v);
}

function edgeKey(a, b) {
    return a < b ? a + "|" + b : b + "|" + a;
}

// Within 3 degrees of 0/45/90 counts as straight (positions imported from lt_karta.svg are not exact)
function isOctilinear(dx, dy) {
    const deg = Math.atan2(dy, dx) * 180 / Math.PI;
    return Math.abs(deg - Math.round(deg / 45) * 45) < 3;
}

function straighten(edge) {
    if (edge.bends && edge.bends.length) return false;
    const a = model.nodes[edge.a], b = model.nodes[edge.b];
    const dx = b.x - a.x, dy = b.y - a.y;
    if (isOctilinear(dx, dy)) return false;
    const m = Math.min(Math.abs(dx), Math.abs(dy));
    edge.bends = [[a.x + Math.sign(dx) * (Math.abs(dx) - m), a.y + Math.sign(dy) * (Math.abs(dy) - m)]];
    return true;
}

async function api(url, opts = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const key = sessionStorage.getItem("admin_api_key") || "";
        const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${key}` } });
        if ((r.status === 401 || r.status === 403) && attempt === 0) {
            const k = prompt("Admin-nyckel (ADMIN_API_KEY):");
            if (!k) throw new Error("Ingen nyckel angiven");
            sessionStorage.setItem("admin_api_key", k.trim());
            continue;
        }
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        return data;
    }
}

function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- Rendering -----------------------------------------------------------------

let rafPending = false;
function render() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
        rafPending = false;
        mapEls = renderMap(model, groups);
        $("ghost").setAttribute("transform", `matrix(${ghostM().join(" ")})`);
        renderOverlay();
    });
}

let mapEls = null;
let hoverId = null;
const LEADER_MIN = 30;   // labels further than this from their stop get a connector in the editor

// Anchor point of a label (where its text starts) in model coordinates
function labelAnchor(n) {
    const lab = n.label || { dx: 14, dy: 6 };
    return [n.x + lab.dx, n.y + lab.dy - (lab.size || model.label_size || 17) / 3];
}

function highlightPair(id) {
    const n = model.nodes[id], t = mapEls && mapEls.labelEls[id];
    if (!n || !t) return;
    const [ax, ay] = labelAnchor(n);
    el("line", { x1: n.x, y1: n.y, x2: ax, y2: ay, stroke: "#1f6feb", "stroke-width": 2.5, "pointer-events": "none" }, overlay);
    el("circle", { cx: n.x, cy: n.y, r: 26, fill: "none", stroke: "#1f6feb", "stroke-width": 4, "stroke-dasharray": "6 4", "pointer-events": "none" }, overlay);
    const b = t.getBBox();
    const g = el("g", { "pointer-events": "none" }, overlay);
    if (t.getAttribute("transform")) g.setAttribute("transform", t.getAttribute("transform"));
    el("rect", { x: b.x - 4, y: b.y - 3, width: b.width + 8, height: b.height + 6, rx: 4, fill: "#1f6feb", "fill-opacity": 0.12, stroke: "#1f6feb", "stroke-width": 2 }, g);
}

function renderOverlay() {
    overlay.replaceChildren();
    // Thin connector from every label that has been moved away from its stop
    for (const n of Object.values(model.nodes)) {
        const lab = n.label;
        if (!lab || Math.hypot(lab.dx, lab.dy) < LEADER_MIN) continue;
        const [ax, ay] = labelAnchor(n);
        el("line", { x1: n.x, y1: n.y, x2: ax, y2: ay, stroke: "#1f6feb", "stroke-width": 1.5, "stroke-opacity": 0.6, "stroke-dasharray": "5 4", "pointer-events": "none" }, overlay);
    }
    if (calib) renderCalibOverlay();
    if (hoverId && (!sel || sel.id !== hoverId)) highlightPair(hoverId);
    if (!sel) return;
    if (sel.type === "node" && model.nodes[sel.id]) highlightPair(sel.id);
    if (sel.type === "edge" && model.edges[sel.id]) {
        const edge = model.edges[sel.id];
        const pts = edgePoints(model, edge);
        el("polyline", {
            points: pts.map(p => p.join(",")).join(" "), fill: "none", stroke: "#1f6feb",
            "stroke-width": 26, "stroke-opacity": 0.25, "stroke-linejoin": "round", "data-edge": sel.id,
        }, overlay);
        (edge.bends || []).forEach((b, i) => {
            el("rect", { x: b[0] - 8, y: b[1] - 8, width: 16, height: 16, fill: "#1f6feb", stroke: "#fff", "stroke-width": 2, class: "bend", "data-bend": i }, overlay);
        });
    }
}

// --- Side panel ----------------------------------------------------------------

function div(cls, text) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
}

function button(text, fn, cls = "") {
    const b = document.createElement("button");
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener("click", fn);
    return b;
}

function numberInput(value, min, max, step, apply) {
    const inp = document.createElement("input");
    inp.type = "number";
    Object.assign(inp, { value, min, max, step });
    inp.addEventListener("change", () => {
        const v = Number(inp.value);
        if (Number.isFinite(v)) edit(() => apply(Math.max(min, Math.min(max, v))));
    });
    return inp;
}

function badge(line) {
    const c = model.lines[line] || { color: "#555", text: "#fff" };
    const b = document.createElement("span");
    b.className = "badge";
    b.style.background = c.color;
    b.style.color = c.text || "#fff";
    b.textContent = line;
    return b;
}

function edit(fn) {
    snapshot();
    fn();
    setDirty();
    render();
    renderSide();
}

const LABEL_PRESETS = {
    "Höger": { dx: 14, dy: 6, anchor: "start" },
    "Vänster": { dx: -14, dy: 6, anchor: "end" },
    "Över": { dx: 0, dy: -18, anchor: "middle" },
    "Under": { dx: 0, dy: 30, anchor: "middle" },
};

function renderSide() {
    const box = $("sel-content");
    box.replaceChildren();
    box.className = "";
    if (sel && sel.type === "node" && model.nodes[sel.id]) {
        const n = model.nodes[sel.id];
        const lab = () => (n.label ||= { dx: 14, dy: 6, anchor: "start" });
        const cur = n.label || {};
        const name = document.createElement("textarea");
        name.rows = 2;
        name.value = n.name;
        name.title = "Enter ger ny rad";
        name.addEventListener("change", () => edit(() => { n.name = name.value.replace(/\s+$/, ""); }));
        box.append(name);

        const pos = div("row");
        pos.append(div("muted", "Placering:"));
        for (const [k, preset] of Object.entries(LABEL_PRESETS)) pos.append(button(k, () => edit(() => { n.label = { ...lab(), ...preset }; }), "small"));
        const just = div("row");
        just.append(div("muted", "Justering:"));
        for (const [k, anchor] of [["Vänster", "start"], ["Mitten", "middle"], ["Höger", "end"]]) {
            just.append(button(k, () => edit(() => { lab().anchor = anchor; }), "small" + ((cur.anchor || "start") === anchor ? " active" : "")));
        }
        const rot = div("row");
        rot.append(div("muted", "Rotation:"));
        for (const d of [-90, -45, 0, 45, 90]) rot.append(button(String(d), () => edit(() => { lab().rotate = d; }), "small" + ((cur.rotate || 0) === d ? " active" : "")));
        rot.append(numberInput(cur.rotate || 0, -180, 180, 5, (v) => { lab().rotate = v; }));
        const size = div("row");
        size.append(div("muted", "Storlek:"), numberInput(cur.size || model.label_size || 17, 8, 60, 1, (v) => { lab().size = v; }));
        if (cur.size) size.append(button("Standard", () => edit(() => { delete lab().size; }), "small"));
        const leader = document.createElement("label");
        leader.className = "check";
        const lcb = document.createElement("input");
        lcb.type = "checkbox";
        lcb.checked = !!cur.leader;
        lcb.addEventListener("change", () => edit(() => { if (lcb.checked) lab().leader = true; else delete lab().leader; }));
        leader.append(lcb, "Ledlinje på kartan");
        const lrow = div("row");
        lrow.append(leader);
        box.append(pos, just, rot, size, lrow);

        const ls = new Set();
        model.edges.forEach(e => { if (e.a === sel.id || e.b === sel.id) e.lines.forEach(l => ls.add(l)); });
        const term = terminalLines(model)[sel.id] || [];
        const icons = div("row");
        icons.append(div("muted", "Linjeikoner:"));
        for (const l of [...ls].sort(lineSort)) {
            const lbl = document.createElement("label");
            lbl.className = "check";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = term.includes(l);
            cb.addEventListener("change", () => edit(() => {
                const set = new Set(term);
                if (cb.checked) set.add(l); else set.delete(l);
                n.terminals = [...set];
            }));
            lbl.append(cb, badge(l));
            icons.append(lbl);
        }
        box.append(icons);
        const iconBtns = div("row");
        if (Array.isArray(n.terminals)) iconBtns.append(button("Automatiska ikoner", () => edit(() => { delete n.terminals; }), "small"));
        if (n.badge) iconBtns.append(button("Auto-placera ikoner", () => edit(() => { delete n.badge; }), "small"));
        if (iconBtns.childElementCount) box.append(iconBtns);

        box.append(div("kv", `id: ${sel.id}`), div("kv", `stop_ids: ${n.stop_ids.join(", ")}`),
            div("kv", `lat/lon: ${n.lat}, ${n.lon}`), div("kv", `x/y: ${n.x}, ${n.y}`));
    } else if (sel && sel.type === "edge" && model.edges[sel.id]) {
        const edge = model.edges[sel.id];
        box.append(div("", `${model.nodes[edge.a].name} - ${model.nodes[edge.b].name}`));
        box.append(div("kv", "Ordning (vänster till höger i ritriktningen):"));
        edge.lines.forEach((l, i) => {
            const row = div("row");
            row.append(badge(l),
                button("Upp", () => edit(() => { if (i > 0) [edge.lines[i - 1], edge.lines[i]] = [edge.lines[i], edge.lines[i - 1]]; }), "small"),
                button("Ner", () => edit(() => { if (i < edge.lines.length - 1) [edge.lines[i + 1], edge.lines[i]] = [edge.lines[i], edge.lines[i + 1]]; }), "small"));
            box.append(row);
        });
        const row = div("row");
        row.append(
            button("Vänd ordning", () => edit(() => edge.lines.reverse())),
            button("Räta upp 45", () => edit(() => { edge.bends = []; straighten(edge); })),
            button("Ta bort knäck", () => edit(() => { edge.bends = []; })),
        );
        box.append(row, div("kv", `Knäck: ${(edge.bends || []).length}. Dubbelklicka på sträckan för att lägga till.`));
    } else {
        box.className = "muted";
        box.textContent = "Klicka på en hållplats eller en linjesträcka.";
    }

    const lc = $("lines-content");
    lc.replaceChildren();
    const ns = div("row");
    ns.append(div("muted", "Namnstorlek (standard):"), numberInput(model.label_size || 17, 8, 60, 1, (v) => { model.label_size = v; }));
    lc.append(ns);
    for (const l of Object.keys(model.lines).sort(lineSort)) {
        const row = div("row");
        const inp = document.createElement("input");
        inp.type = "color";
        inp.value = model.lines[l].color;
        inp.addEventListener("change", () => edit(() => { model.lines[l].color = inp.value; }));
        const count = model.edges.filter(e => e.lines.includes(l)).length;
        row.append(badge(l), inp, div("muted", `${count} sträckor`));
        lc.append(row);
    }
}

function select(s) {
    sel = s;
    renderOverlay();
    renderSide();
}

// --- Dragging ------------------------------------------------------------------

function startDrag(e, onMove) {
    e.stopPropagation();
    e.preventDefault();
    const [sx, sy] = pz.toModel(e.clientX, e.clientY);
    let moved = false;
    const move = (ev) => {
        const [mx, my] = pz.toModel(ev.clientX, ev.clientY);
        let dx = mx - sx, dy = my - sy;
        if (!moved) { if (Math.hypot(dx, dy) * pz.view.s < 3) return; snapshot(); moved = true; }
        if (ev.shiftKey) {
            const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = dx * Math.cos(ang) + dy * Math.sin(ang);
            dx = Math.cos(ang) * len; dy = Math.sin(ang) * len;
        }
        onMove(dx, dy);
        render();
    };
    const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (moved) { setDirty(); renderSide(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
}

groups.nodes.addEventListener("pointerdown", (e) => {
    const id = e.target.dataset.node;
    if (!id || e.button !== 0) return;
    if (calib) { e.stopPropagation(); return; }   // calibration picks stops on click, no drag
    const n = model.nodes[id], ox = n.x, oy = n.y;
    // With the background shown, stops snap to its circles (12 px on screen)
    const circles = ghostVisible() ? circlesInMap(ghostM()) : [];
    select({ type: "node", id });
    startDrag(e, (dx, dy) => {
        let x = ox + dx, y = oy + dy, best = 12 / pz.view.s, hit = null;
        for (const c of circles) {
            const d = Math.hypot(c[0] - x, c[1] - y);
            if (d < best) { best = d; hit = c; }
        }
        n.x = hit ? Math.round(hit[0]) : snap(x);
        n.y = hit ? Math.round(hit[1]) : snap(y);
    });
});

// Hovering a stop or its name highlights both
for (const g of [groups.nodes, groups.labels]) {
    g.addEventListener("pointerover", (e) => {
        const id = e.target.dataset.node || e.target.dataset.label || e.target.dataset.badge;
        if (id && id !== hoverId) { hoverId = id; renderOverlay(); }
    });
    g.addEventListener("pointerout", () => { if (hoverId) { hoverId = null; renderOverlay(); } });
}

groups.nodes.addEventListener("pointerdown", (e) => {
    const id = e.target.dataset.badge;
    if (!id || e.button !== 0 || calib) return;
    const n = model.nodes[id];
    const b = groups.nodes.querySelector(`g[data-badge="${CSS.escape(id)}"]`).getBBox();
    const ox = b.x + b.width / 2 - n.x, oy = b.y + b.height / 2 - n.y;
    select({ type: "node", id });
    startDrag(e, (dx, dy) => { n.badge = { dx: Math.round(ox + dx), dy: Math.round(oy + dy) }; });
});

groups.labels.addEventListener("pointerdown", (e) => {
    const id = e.target.dataset.label;
    if (!id || e.button !== 0 || calib) return;
    const n = model.nodes[id];
    n.label = n.label || { dx: 14, dy: 6, anchor: "start" };
    const ox = n.label.dx, oy = n.label.dy;
    select({ type: "node", id });
    startDrag(e, (dx, dy) => { n.label.dx = Math.round(ox + dx); n.label.dy = Math.round(oy + dy); });
});

overlay.addEventListener("pointerdown", (e) => {
    if (e.target.dataset.bend == null || e.button !== 0) return;
    const edge = model.edges[sel.id], i = Number(e.target.dataset.bend);
    const [ox, oy] = edge.bends[i];
    startDrag(e, (dx, dy) => { edge.bends[i] = [snap(ox + dx), snap(oy + dy)]; });
});

overlay.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    const edge = model.edges[sel && sel.id];
    if (!edge) return;
    if (e.target.dataset.bend != null) {
        edit(() => edge.bends.splice(Number(e.target.dataset.bend), 1));
        return;
    }
    const [mx, my] = pz.toModel(e.clientX, e.clientY);
    const pts = edgePoints(model, edge);
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        const abx = bx - ax, aby = by - ay, len2 = abx * abx + aby * aby || 1;
        const t = Math.max(0, Math.min(1, ((mx - ax) * abx + (my - ay) * aby) / len2));
        const d = Math.hypot(mx - ax - t * abx, my - ay - t * aby);
        if (d < bestD) { bestD = d; bestI = i; }
    }
    edit(() => { edge.bends = edge.bends || []; edge.bends.splice(bestI, 0, [snap(mx), snap(my)]); });
});

groups.edges.addEventListener("click", (e) => {
    const idx = e.target.dataset.edge;
    if (idx == null) return;
    e.stopPropagation();
    select({ type: "edge", id: Number(idx) });
});

for (const g of [groups.nodes, groups.labels, overlay]) g.addEventListener("click", (e) => e.stopPropagation());
svg.addEventListener("click", () => { if (sel) select(null); });

window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); return; }
    if (e.key === "Escape") {
        if (calib && calib.pendingNode) { calib.pendingNode = null; calibStatus(); renderOverlay(); }
        else if (calib) endCalib();
        else select(null);
        return;
    }
    if (sel && sel.type === "node" && !e.ctrlKey && !e.metaKey) {
        const n = model.nodes[sel.id];
        const lab = () => (n.label ||= { dx: 14, dy: 6, anchor: "start" });
        if (e.key === "r" || e.key === "R") {
            const r = (lab().rotate || 0) + (e.shiftKey ? -45 : 45);
            edit(() => { lab().rotate = ((r + 180) % 360 + 360) % 360 - 180; });
            return;
        }
        if (e.key === "+" || e.key === "=" || e.key === "-") {
            const size = (lab().size || model.label_size || 17) + (e.key === "-" ? -1 : 1);
            edit(() => { lab().size = Math.max(8, Math.min(60, size)); });
            return;
        }
    }
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (dirs[e.key] && sel && sel.type === "node") {
        e.preventDefault();
        const n = model.nodes[sel.id], step = GRID * (e.shiftKey ? 5 : 1);
        edit(() => { n.x += dirs[e.key][0] * step; n.y += dirs[e.key][1] * step; });
    }
});

window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

// --- Actions -------------------------------------------------------------------

function undo() {
    if (!history.length) return;
    model = JSON.parse(history.pop());
    setDirty();
    render();
    renderSide();
    renderCalib();
}

async function save() {
    try {
        status("Sparar...");
        await api("/api/admin/schematic", {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(model),
        });
        dirty = false;
        status("Sparad " + new Date().toLocaleTimeString("sv-SE"));
    } catch (e) {
        status("Kunde inte spara: " + e.message, "error");
    }
}

let stale = { nodes: [], edges: [], lines: [] };

async function mergeGenerated() {
    let gen;
    try {
        status("Hämtar från GTFS...");
        gen = await api("/api/admin/schematic/generate?lines=" + encodeURIComponent(Object.keys(model.lines).join(",")));
    } catch (e) {
        status("Kunde inte hämta: " + e.message, "error");
        return;
    }
    snapshot();
    const common = Object.keys(gen.nodes).filter(id => model.nodes[id]);
    const move = fitAffine(common.map(id => [gen.nodes[id].x, gen.nodes[id].y]), common.map(id => [model.nodes[id].x, model.nodes[id].y]));
    const added = [];
    for (const [id, n] of Object.entries(gen.nodes)) {
        if (model.nodes[id]) {
            Object.assign(model.nodes[id], { stop_ids: n.stop_ids, lat: n.lat, lon: n.lon });
        } else {
            const [x, y] = move([n.x, n.y]);
            model.nodes[id] = { ...n, x: snap(x), y: snap(y) };
            added.push(id);
        }
    }
    const existing = new Map(model.edges.map(e => [edgeKey(e.a, e.b), e]));
    const genKeys = new Map(gen.edges.map(e => [edgeKey(e.a, e.b), e]));
    let newEdges = 0;
    for (const [k, ge] of genKeys) {
        const e = existing.get(k);
        if (!e) { model.edges.push({ ...ge, bends: [] }); newEdges++; }
        else ge.lines.forEach(l => { if (!e.lines.includes(l)) e.lines.push(l); });
    }
    for (const [l, c] of Object.entries(gen.lines)) if (!model.lines[l]) model.lines[l] = c;
    model.patterns = gen.patterns;
    stale = {
        nodes: Object.keys(model.nodes).filter(id => !gen.nodes[id]),
        edges: model.edges.filter(e => !genKeys.has(edgeKey(e.a, e.b))),
        lines: model.edges.flatMap(e => {
            const ge = genKeys.get(edgeKey(e.a, e.b));
            return ge ? e.lines.filter(l => !ge.lines.includes(l)).map(l => [e, l]) : [];
        }),
    };
    setDirty();
    render();
    renderSide();
    renderCheck(added, newEdges);
}

function renderCheck(added, newEdges) {
    const box = $("check-content");
    box.replaceChildren();
    box.className = "";
    box.append(div("", `Nya hållplatser: ${added.length}, nya sträckor: ${newEdges}`));
    const list = (title, ids) => {
        if (!ids.length) return;
        box.append(div("kv", title));
        const ul = document.createElement("ul");
        ul.className = "list";
        for (const id of ids) {
            const li = document.createElement("li");
            li.className = "linkish";
            li.textContent = model.nodes[id] ? model.nodes[id].name : id;
            li.addEventListener("click", () => {
                select({ type: "node", id });
                const n = model.nodes[id], r = svg.getBoundingClientRect();
                pz.view.s = Math.max(pz.view.s, 0.6);
                pz.view.x = r.width / 2 - n.x * pz.view.s;
                pz.view.y = r.height / 2 - n.y * pz.view.s;
                pz.apply();
            });
            ul.append(li);
        }
        box.append(ul);
    };
    list("Tillagda (kontrollera placeringen):", added);
    list("Finns inte längre i GTFS:", stale.nodes);
    const n = stale.nodes.length + stale.edges.length + stale.lines.length;
    if (n) {
        box.append(button(`Ta bort inaktuella (${stale.nodes.length} hållplatser, ${stale.edges.length} sträckor, ${stale.lines.length} linjer på sträckor)`, () => edit(() => {
            stale.lines.forEach(([e, l]) => { e.lines = e.lines.filter(x => x !== l); });
            const dropNodes = new Set(stale.nodes), dropEdges = new Set(stale.edges);
            model.edges = model.edges.filter(e => !dropEdges.has(e) && e.lines.length && !dropNodes.has(e.a) && !dropNodes.has(e.b));
            dropNodes.forEach(id => delete model.nodes[id]);
            stale = { nodes: [], edges: [], lines: [] };
            sel = null;
            $("check-content").textContent = "Inaktuella borttagna.";
        })));
    }
}

// --- Background calibration -----------------------------------------------------

function ghostM() {
    return (model.ghost && model.ghost.matrix) || IDENTITY;
}

function ghostVisible() {
    return $("chk-ghost").checked;
}

function showGhost() {
    $("chk-ghost").checked = true;
    $("ghost").setAttribute("display", "inline");
}

function recomputeGhost() {
    const pts = model.ghost.points.filter(p => model.nodes[p.node]);
    const pairs = pts.map(p => [[p.gx, p.gy], [model.nodes[p.node].x, model.nodes[p.node].y]]);
    const m = ghostMatrix(pairs);
    if (m) { model.ghost.matrix = m; return; }
    if (pairs.length === 1) {
        // One point: only move the background so the point lands on its stop
        const cur = ghostM().slice();
        const [x, y] = applyMatrix(cur, pairs[0][0]);
        cur[4] += pairs[0][1][0] - x;
        cur[5] += pairs[0][1][1] - y;
        model.ghost.matrix = cur;
    }
}

function calibStatus() {
    if (!calib) return;
    status(calib.pendingNode
        ? `Klicka "${model.nodes[calib.pendingNode].name}" i bakgrunden`
        : "Kalibrering: klicka en hållplats i kartan", "dirty");
}

function renderCalibOverlay() {
    const m = ghostM();
    for (const p of (model.ghost && model.ghost.points) || []) {
        const n = model.nodes[p.node];
        if (!n) continue;
        const [gx, gy] = applyMatrix(m, [p.gx, p.gy]);
        el("line", { x1: n.x, y1: n.y, x2: gx, y2: gy, stroke: "#d29922", "stroke-width": 3, "pointer-events": "none" }, overlay);
        el("circle", { cx: n.x, cy: n.y, r: 22, fill: "none", stroke: "#d29922", "stroke-width": 4, "pointer-events": "none" }, overlay);
        el("circle", { cx: gx, cy: gy, r: 14, fill: "none", stroke: "#2ea043", "stroke-width": 4, "pointer-events": "none" }, overlay);
    }
    if (calib.pendingNode && model.nodes[calib.pendingNode]) {
        const n = model.nodes[calib.pendingNode];
        el("circle", { cx: n.x, cy: n.y, r: 30, fill: "#d29922", "fill-opacity": 0.25, stroke: "#d29922", "stroke-width": 5, "pointer-events": "none" }, overlay);
    }
}

function renderCalib() {
    $("calib-panel").hidden = !calib;
    const ul = $("calib-points");
    ul.replaceChildren();
    if (!calib) return;
    const m = ghostM();
    const pts = (model.ghost && model.ghost.points) || [];
    pts.forEach((p, i) => {
        const n = model.nodes[p.node];
        if (!n) return;
        const [gx, gy] = applyMatrix(m, [p.gx, p.gy]);
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = `${n.name} (fel ${Math.round(Math.hypot(gx - n.x, gy - n.y))})`;
        li.append(name, button("Ta bort", () => {
            snapshot();
            model.ghost.points.splice(i, 1);
            recomputeGhost();
            setDirty();
            render();
            renderCalib();
        }, "small"));
        ul.append(li);
    });
    if (!pts.length) ul.append(div("muted", "Inga punkter än."));
}

function startCalib() {
    calib = { pendingNode: null };
    showGhost();
    select(null);
    renderCalib();
    calibStatus();
    renderOverlay();
}

function endCalib() {
    calib = null;
    renderCalib();
    renderOverlay();
    status(dirty ? "Osparade ändringar" : "", dirty ? "dirty" : "");
}

// Calibration clicks are handled before everything else (pans are already swallowed by svgPanZoom)
svg.addEventListener("click", (e) => {
    if (!calib) return;
    e.stopPropagation();
    const id = e.target.dataset && e.target.dataset.node;
    if (id) {
        calib.pendingNode = id;
        calibStatus();
        renderOverlay();
        return;
    }
    if (!calib.pendingNode) { calibStatus(); return; }
    const [mx, my] = pz.toModel(e.clientX, e.clientY);
    let [gx, gy] = applyMatrix(invertMatrix(ghostM()), [mx, my]);
    let best = 25;
    for (const c of SVG_STOP_CIRCLES) {
        const d = Math.hypot(c[0] - gx, c[1] - gy);
        if (d < best) { best = d; [gx, gy] = c; }
    }
    snapshot();
    model.ghost = model.ghost || { matrix: IDENTITY.slice(), points: [] };
    model.ghost.points = model.ghost.points.filter(p => p.node !== calib.pendingNode);
    model.ghost.points.push({ node: calib.pendingNode, gx, gy });
    recomputeGhost();
    calib.pendingNode = null;
    setDirty();
    render();
    renderCalib();
    calibStatus();
}, true);

function snapToCircles() {
    if (!model.ghost || model.ghost.points.length < 2) {
        status("Kalibrera bakgrunden först (minst 2 punkter)", "error");
        return;
    }
    if (!confirm("Flytta hållplatserna till närmaste cirkel i bakgrunden? (Kan ångras)")) return;
    snapshot();
    const m = ghostM();
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const n = snapNodesToCircles(model, m, 40 * scale);
    showGhost();
    setDirty();
    render();
    renderSide();
    status(`${n} av ${Object.keys(model.nodes).length} hållplatser flyttade till cirklar`, "dirty");
}

function exportSvg() {
    const tmp = { edges: el("g"), nodes: el("g"), labels: el("g") };
    renderMap(model, tmp);
    for (const g of Object.values(tmp)) g.querySelectorAll("*").forEach(n => {
        for (const a of [...n.attributes]) if (a.name.startsWith("data-")) n.removeAttribute(a.name);
    });
    const { width: w, height: h } = model;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="${NS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
        + `<rect width="${w}" height="${h}" fill="#ffffff"/>`
        + `<g id="linjer">${tmp.edges.innerHTML}</g><g id="hallplatser">${tmp.nodes.innerHTML}</g><g id="namn">${tmp.labels.innerHTML}</g></svg>`;
    download("linjekarta.svg", xml, "image/svg+xml");
}

function importJson(file) {
    file.text().then((text) => {
        const m = JSON.parse(text);
        if (!m.nodes || !Array.isArray(m.edges) || !m.lines) throw new Error("Ogiltig kartmodell");
        snapshot();
        model = m;
        sel = null;
        setDirty();
        render();
        renderSide();
    }).catch(e => status("Import misslyckades: " + e.message, "error"));
}

$("btn-save").addEventListener("click", save);
$("btn-undo").addEventListener("click", undo);
$("btn-merge").addEventListener("click", mergeGenerated);
$("btn-calib").addEventListener("click", () => (calib ? endCalib() : startCalib()));
$("btn-calib-done").addEventListener("click", endCalib);
$("btn-calib-clear").addEventListener("click", () => {
    if (!model.ghost) return;
    snapshot();
    delete model.ghost;
    setDirty();
    render();
    renderCalib();
});
$("btn-snap-circles").addEventListener("click", snapToCircles);
$("rng-ghost").addEventListener("input", (e) => $("ghost").setAttribute("opacity", e.target.value));
$("btn-straighten").addEventListener("click", () => {
    snapshot();
    const n = model.edges.filter(straighten).length;
    if (!n) { history.pop(); status("Alla raka sträckor går redan i 0/45/90 grader"); return; }
    setDirty();
    render();
    status(`${n} sträckor uppräta`, "dirty");
});
$("chk-ghost").addEventListener("change", (e) => $("ghost").setAttribute("display", e.target.checked ? "inline" : "none"));
$("btn-export-svg").addEventListener("click", exportSvg);
$("btn-export-json").addEventListener("click", () => download("schematic.json", JSON.stringify(model, null, 1), "application/json"));
$("btn-import-json").addEventListener("click", () => $("file-json").click());
$("file-json").addEventListener("change", (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; });

// --- Start ---------------------------------------------------------------------

(async () => {
    try {
        const r = await fetch("/api/schematic");
        model = await r.json();
        if (!r.ok) throw new Error(model.error || r.status);
    } catch (e) {
        status("Kunde inte hämta kartan: " + e.message, "error");
        return;
    }
    const saved = model.saved;
    delete model.saved;
    $("paper").setAttribute("width", model.width);
    $("paper").setAttribute("height", model.height);
    const b = modelBounds(model, 200);
    pz.fit(b.x, b.y, b.w, b.h);
    render();
    renderSide();
    status(saved ? "Sparad modell" : "Genererad startlayout (inte sparad än)", saved ? "" : "dirty");
})();
