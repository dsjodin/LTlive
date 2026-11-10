/**
 * svgPanZoom.js - pan (drag) and zoom (wheel / pinch) of a <g> inside an <svg>.
 * The svg has no viewBox: transform values are CSS pixels.
 * Elements that start their own drag call e.stopPropagation() on pointerdown.
 */

export function attachPanZoom(svg, g, { minScale = 0.05, maxScale = 10, onChange = null } = {}) {
    const v = { x: 0, y: 0, s: 1 };
    const pointers = new Map();
    let start = null, moved = false;

    function apply() {
        g.setAttribute("transform", `translate(${v.x.toFixed(1)},${v.y.toFixed(1)}) scale(${v.s.toFixed(4)})`);
        if (onChange) onChange(v);
    }

    function zoomAt(mx, my, factor) {
        const s = Math.max(minScale, Math.min(maxScale, v.s * factor));
        const k = s / v.s;
        v.x = mx - k * (mx - v.x);
        v.y = my - k * (my - v.y);
        v.s = s;
        apply();
    }

    // Fit the model rectangle (x, y, w, h) into the svg
    function fit(x, y, w, h, pad = 16) {
        const r = svg.getBoundingClientRect();
        v.s = Math.min((r.width - 2 * pad) / w, (r.height - 2 * pad) / h);
        v.x = (r.width - w * v.s) / 2 - x * v.s;
        v.y = (r.height - h * v.s) / 2 - y * v.s;
        apply();
    }

    function toModel(clientX, clientY) {
        const r = svg.getBoundingClientRect();
        return [(clientX - r.left - v.x) / v.s, (clientY - r.top - v.y) / v.s];
    }

    function snapshot() {
        const pts = [...pointers.values()];
        const r = svg.getBoundingClientRect();
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length - r.left;
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length - r.top;
        const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
        return { cx, cy, dist, x: v.x, y: v.y, s: v.s };
    }

    svg.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        start = snapshot();
        moved = false;
    });
    window.addEventListener("pointermove", (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const now = snapshot();
        if (Math.hypot(now.cx - start.cx, now.cy - start.cy) > 4 || Math.abs(now.dist - start.dist) > 4) moved = true;
        if (pointers.size > 1 && start.dist > 0) {
            const s = Math.max(minScale, Math.min(maxScale, start.s * now.dist / start.dist));
            const k = s / start.s;
            v.s = s;
            v.x = now.cx - k * (start.cx - start.x);
            v.y = now.cy - k * (start.cy - start.y);
        } else {
            v.x = start.x + now.cx - start.cx;
            v.y = start.y + now.cy - start.cy;
        }
        apply();
    });
    const end = (e) => {
        if (!pointers.delete(e.pointerId)) return;
        if (pointers.size) start = snapshot();
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    // Swallow the click that ends a pan so it does not select or close anything
    svg.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); moved = false; } }, true);

    svg.addEventListener("wheel", (e) => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });

    return { view: v, apply, fit, toModel, zoomAt };
}
