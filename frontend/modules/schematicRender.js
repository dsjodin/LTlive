/**
 * schematicRender.js - drawing and geometry for the schematic map model.
 * Shared by stadstrafiken.js (live map) and schematic-editor.js so both look identical.
 * Only SVG presentation attributes are used (no CSS), so an exported SVG is self-contained.
 */

export const NS = "http://www.w3.org/2000/svg";
export const LINE_WIDTH = 7;
export const LINE_SPACING = 9;
const CORNER_R = 24;

export function el(tag, attrs = {}, parent = null) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
}

export function lineSort(a, b) {
    const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
    if (na && nb) return Number(a) - Number(b);
    if (na !== nb) return na ? -1 : 1;
    return a.localeCompare(b);
}

// --- Geometry --------------------------------------------------------------

export function edgePoints(model, edge) {
    const a = model.nodes[edge.a], b = model.nodes[edge.b];
    return [[a.x, a.y], ...(edge.bends || []), [b.x, b.y]];
}

function offsetPolyline(pts, d) {
    if (d === 0) return pts.map(p => [p[0], p[1]]);
    const normals = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
        const len = Math.hypot(dx, dy) || 1;
        normals.push([dy / len, -dx / len]);
    }
    return pts.map((p, i) => {
        const n1 = normals[Math.max(0, i - 1)], n2 = normals[Math.min(normals.length - 1, i)];
        let nx = n1[0] + n2[0], ny = n1[1] + n2[1];
        const len = Math.hypot(nx, ny);
        if (len < 1e-6) { nx = n2[0]; ny = n2[1]; } else { nx /= len; ny /= len; }
        const miter = Math.max(0.5, nx * n2[0] + ny * n2[1]);
        return [p[0] + nx * d / miter, p[1] + ny * d / miter];
    });
}

/**
 * Polyline for one line inside an edge. Lines are spread left-to-right in edge.lines order,
 * measured along the edge drawn in its canonical direction (rightwards, or downwards when
 * vertical), so a line keeps its side through a straight corridor.
 */
export function edgeLinePoints(model, edge, line) {
    const i = edge.lines.indexOf(line);
    if (i < 0) return null;
    const pts = edgePoints(model, edge);
    const dx = pts[pts.length - 1][0] - pts[0][0], dy = pts[pts.length - 1][1] - pts[0][1];
    const flip = dx < -0.01 || (Math.abs(dx) <= 0.01 && dy < 0);
    const off = (i - (edge.lines.length - 1) / 2) * LINE_SPACING;
    return offsetPolyline(pts, flip ? -off : off);
}

export function polyLength(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return s;
}

/** Point at arc-length fraction t (0..1) with tangent angle in degrees. */
export function pointAt(pts, t) {
    const total = polyLength(pts);
    let target = Math.max(0, Math.min(1, t)) * total;
    for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const seg = Math.hypot(bx - ax, by - ay);
        if (target <= seg || i === pts.length - 1) {
            const u = seg > 0 ? Math.min(1, target / seg) : 0;
            return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, angle: Math.atan2(by - ay, bx - ax) * 180 / Math.PI };
        }
        target -= seg;
    }
    return { x: pts[0][0], y: pts[0][1], angle: 0 };
}

/** Points from fraction t0 to t1 along pts (reversed when t1 < t0). */
export function subPath(pts, t0, t1) {
    if (t1 < t0) return subPath(pts, t1, t0).reverse();
    const total = polyLength(pts);
    const s0 = t0 * total, s1 = t1 * total;
    const out = [];
    let acc = 0;
    const p0 = pointAt(pts, t0);
    out.push([p0.x, p0.y]);
    for (let i = 1; i < pts.length - 1; i++) {
        acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (acc > s0 && acc < s1) out.push([pts[i][0], pts[i][1]]);
    }
    const p1 = pointAt(pts, t1);
    out.push([p1.x, p1.y]);
    return out;
}

/** SVG path data with rounded corners. */
export function roundedPath(pts, r = CORNER_R) {
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
        const [px, py] = pts[i - 1], [vx, vy] = pts[i], [nx, ny] = pts[i + 1];
        const l1 = Math.hypot(vx - px, vy - py) || 1, l2 = Math.hypot(nx - vx, ny - vy) || 1;
        const r1 = Math.min(r, l1 / 2), r2 = Math.min(r, l2 / 2);
        const ax = vx - (vx - px) / l1 * r1, ay = vy - (vy - py) / l1 * r1;
        const bx = vx + (nx - vx) / l2 * r2, by = vy + (ny - vy) / l2 * r2;
        d += ` L${ax.toFixed(1)},${ay.toFixed(1)} Q${vx.toFixed(1)},${vy.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last[0].toFixed(1)},${last[1].toFixed(1)}`;
}

/** Bounding box {x, y, w, h} of all nodes and bends, expanded by pad. */
export function modelBounds(model, pad = 80) {
    const pts = Object.values(model.nodes).map(n => [n.x, n.y]);
    for (const e of model.edges) pts.push(...(e.bends || []));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
    return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

/** Max number of parallel lines at each node (sets the station marker size). */
export function nodeWidths(model) {
    const w = {};
    for (const e of model.edges) {
        w[e.a] = Math.max(w[e.a] || 1, e.lines.length);
        w[e.b] = Math.max(w[e.b] || 1, e.lines.length);
    }
    return w;
}

// --- Drawing ---------------------------------------------------------------

/**
 * Draw the network into the groups {edges, nodes, labels}.
 * opts.hiddenLines: Set of line names drawn faded.
 * opts.interactive: false makes the terminal line badges ignore clicks.
 * Returns {edgeEls: [[pathEl, line], ...] per edge index, nodeEls: {id: el}, labelEls: {id: el}}.
 */
export function renderMap(model, groups, opts = {}) {
    const hidden = opts.hiddenLines || new Set();
    for (const g of Object.values(groups)) g.replaceChildren();
    const edgeEls = [], nodeEls = {}, labelEls = {};

    model.edges.forEach((edge, idx) => {
        const els = [];
        for (const line of edge.lines) {
            const pts = edgeLinePoints(model, edge, line);
            const color = (model.lines[line] || {}).color || "#888";
            const p = el("path", {
                d: roundedPath(pts), fill: "none", stroke: color,
                "stroke-width": LINE_WIDTH, "stroke-linecap": "round", "stroke-linejoin": "round",
                "stroke-opacity": hidden.has(line) ? 0.15 : 1,
                "data-edge": idx, "data-line": line,
            }, groups.edges);
            els.push([p, line]);
        }
        edgeEls.push(els);
    });

    const widths = nodeWidths(model);
    const radius = (id) => ((widths[id] || 1) - 1) * LINE_SPACING / 2 + LINE_WIDTH / 2 + 3;
    for (const [id, n] of Object.entries(model.nodes)) {
        nodeEls[id] = el("circle", {
            cx: n.x, cy: n.y, r: radius(id), fill: "#ffffff", stroke: "#1c1c1e", "stroke-width": 3, "data-node": id,
        }, groups.nodes);
        labelEls[id] = drawLabel(model, id, n, groups.labels);
    }

    for (const [id, lines] of Object.entries(terminalLines(model))) {
        drawBadges(model, id, lines, radius(id), groups.nodes, hidden, opts.interactive !== false);
    }
    return { edgeEls, nodeEls, labelEls };
}

function drawLabel(model, id, n, parent) {
    const lab = n.label || { dx: 14, dy: 6, anchor: "start" };
    const x = n.x + lab.dx, y = n.y + lab.dy;
    const attrs = {
        x, y, "text-anchor": lab.anchor || "start",
        "font-size": lab.size || model.label_size || 17, "font-weight": 600, "font-family": "Helvetica, Arial, sans-serif",
        fill: "#1c1c1e", stroke: "#ffffff", "stroke-width": 4, "stroke-linejoin": "round",
        "paint-order": "stroke", "data-label": id,
    };
    if (lab.rotate) attrs.transform = `rotate(${lab.rotate} ${x} ${y})`;
    if (lab.leader) {
        // Thin line from the stop to a label placed away from it
        const ty = y - (lab.size || model.label_size || 17) / 3;
        const len = Math.hypot(x - n.x, ty - n.y) || 1;
        el("line", {
            x1: n.x + (x - n.x) / len * 10, y1: n.y + (ty - n.y) / len * 10, x2: x, y2: ty,
            stroke: "#1c1c1e", "stroke-width": 1.5, "pointer-events": "none",
        }, parent);
    }
    const t = el("text", attrs, parent);
    const rows = String(n.name).split("\n");
    if (rows.length === 1) {
        t.textContent = n.name;
        return t;
    }
    // Labels placed above the stop grow upwards, all others downwards
    rows.forEach((row, i) => {
        const dy = i ? "1.15em" : (lab.dy < 0 ? `${-(rows.length - 1) * 1.15}em` : "0");
        el("tspan", { x, dy, "data-label": id }, t).textContent = row;
    });
    return t;
}

/** {nodeId: [line, ...]} - node.terminals if set, otherwise nodes where a line has only one edge. */
export function terminalLines(model) {
    const degree = {};
    for (const e of model.edges) {
        for (const l of e.lines) {
            for (const id of [e.a, e.b]) {
                const k = id + "|" + l;
                degree[k] = (degree[k] || 0) + 1;
            }
        }
    }
    const out = {};
    for (const [k, d] of Object.entries(degree)) {
        if (d !== 1) continue;
        const i = k.lastIndexOf("|");
        (out[k.slice(0, i)] ||= []).push(k.slice(i + 1));
    }
    for (const [id, n] of Object.entries(model.nodes)) {
        if (Array.isArray(n.terminals)) out[id] = [...n.terminals];
    }
    for (const id of Object.keys(out)) {
        out[id] = out[id].filter(l => model.lines[l]).sort(lineSort);
        if (!out[id].length) delete out[id];
    }
    return out;
}

export const BADGE_R = 15;

// Line-number circles at a terminal: outwards past the stop along the line, or at node.badge.
function drawBadges(model, id, lines, nodeR, parent, hidden, interactive) {
    const n = model.nodes[id];
    let cx, cy, px, py;
    if (n.badge) {
        cx = n.x + n.badge.dx; cy = n.y + n.badge.dy; px = 1; py = 0;
    } else {
        let dx = 0, dy = 0;
        for (const e of model.edges) {
            if (e.a !== id && e.b !== id) continue;
            if (!e.lines.some(l => lines.includes(l))) continue;
            const pts = edgePoints(model, e);
            const nb = e.a === id ? pts[1] : pts[pts.length - 2];
            const len = Math.hypot(n.x - nb[0], n.y - nb[1]) || 1;
            dx += (n.x - nb[0]) / len; dy += (n.y - nb[1]) / len;
        }
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
        const dist = nodeR + BADGE_R + 6;
        cx = n.x + dx * dist; cy = n.y + dy * dist; px = -dy; py = dx;
    }
    const g = el("g", { "data-badge": id }, parent);
    if (!interactive) g.setAttribute("pointer-events", "none");
    lines.forEach((l, i) => {
        const off = (i - (lines.length - 1) / 2) * (2 * BADGE_R + 6);
        const x = cx + px * off, y = cy + py * off;
        const c = model.lines[l];
        const op = hidden.has(l) ? 0.25 : 1;
        // Rounded square (line sign) so it is not mistaken for a bus
        const w = BADGE_R * 2 + Math.max(0, l.length - 2) * 9;
        el("rect", {
            x: x - w / 2, y: y - BADGE_R, width: w, height: BADGE_R * 2, rx: 7,
            fill: c.color, stroke: "#ffffff", "stroke-width": 3, opacity: op, "data-badge": id,
        }, g);
        el("text", {
            x, y, "text-anchor": "middle", "dominant-baseline": "central", "font-size": 16, "font-weight": 800,
            "font-family": "Helvetica, Arial, sans-serif", fill: c.text || "#ffffff", opacity: op, "data-badge": id,
        }, g).textContent = l;
    });
}
