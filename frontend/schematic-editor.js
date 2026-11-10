/**
 * schematic-editor.js - edit the schematic map model used by stadstrafiken.html.
 * Loads /api/schematic, saves with PUT /api/admin/schematic (admin key, LAN only).
 */

import { el, NS, renderMap, edgePoints, lineSort, modelBounds } from "./modules/schematicRender.js";
import { attachPanZoom } from "./modules/svgPanZoom.js";
import { seedFromLtKarta, fitAffine } from "./modules/ltKartaSeed.js";

const GRID = 10;
const $ = (id) => document.getElementById(id);

let model = null;
let sel = null;            // {type: "node"|"edge", id}
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
        renderMap(model, groups);
        renderOverlay();
    });
}

function renderOverlay() {
    overlay.replaceChildren();
    if (!sel) return;
    if (sel.type === "node" && model.nodes[sel.id]) {
        const n = model.nodes[sel.id];
        el("circle", { cx: n.x, cy: n.y, r: 30, fill: "none", stroke: "#1f6feb", "stroke-width": 4, "stroke-dasharray": "6 4", "pointer-events": "none" }, overlay);
    }
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
        const row = div("row");
        const name = document.createElement("input");
        name.type = "text";
        name.value = n.name;
        name.addEventListener("change", () => edit(() => { n.name = name.value; }));
        row.append(name);
        box.append(row);
        const lab = div("row");
        lab.append(div("muted", "Etikett:"));
        for (const [k, preset] of Object.entries(LABEL_PRESETS)) lab.append(button(k, () => edit(() => { n.label = { ...preset }; }), "small"));
        box.append(lab);
        box.append(div("kv", `id: ${sel.id}`), div("kv", `stop_ids: ${n.stop_ids.join(", ")}`),
            div("kv", `lat/lon: ${n.lat}, ${n.lon}`), div("kv", `x/y: ${n.x}, ${n.y}`));
        const lines = div("row");
        const ls = new Set();
        model.edges.forEach(e => { if (e.a === sel.id || e.b === sel.id) e.lines.forEach(l => ls.add(l)); });
        [...ls].sort(lineSort).forEach(l => lines.append(badge(l)));
        box.append(lines);
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
    const n = model.nodes[id], ox = n.x, oy = n.y;
    select({ type: "node", id });
    startDrag(e, (dx, dy) => { n.x = snap(ox + dx); n.y = snap(oy + dy); });
});

groups.labels.addEventListener("pointerdown", (e) => {
    const id = e.target.dataset.label;
    if (!id || e.button !== 0) return;
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
    if (e.target.tagName === "INPUT") return;
    if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); return; }
    if (e.key === "Escape") { select(null); return; }
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

async function seed() {
    if (!confirm("Flytta hållplatserna till positionerna i lt_karta.svg? (Kan ångras)")) return;
    try {
        status("Hämtar linjeformer...");
        const routes = (await fetch("/api/routes/all").then(r => r.json())).routes || [];
        const ids = routes.filter(r => model.lines[r.route_short_name]).map(r => r.route_id);
        const bulk = await fetch("/api/shapes/bulk?route_ids=" + encodeURIComponent(ids.join(","))).then(r => r.json());
        const lineOf = Object.fromEntries(routes.map(r => [r.route_id, r.route_short_name]));
        const shapes = {};
        for (const [rid, list] of Object.entries(bulk.routes || {})) {
            for (const pts of list) {
                const l = lineOf[rid];
                if (!shapes[l] || pts.length > shapes[l].length) shapes[l] = pts;
            }
        }
        snapshot();
        const n = seedFromLtKarta(model, shapes);
        $("chk-ghost").checked = true;
        $("ghost").setAttribute("display", "inline");
        setDirty();
        render();
        renderSide();
        status(`${n} hållplatser placerade från lt_karta.svg`, "dirty");
    } catch (e) {
        status("Import misslyckades: " + e.message, "error");
    }
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
$("btn-seed").addEventListener("click", seed);
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
