/**
 * bottomSheet.js — Draggable bottom sheet with snap points for mobile panels.
 *
 * Usage:
 *   new BottomSheet(panelEl, {
 *       snapPoints: [25, 50, 90],   // vh values for peek, half, full
 *       onClose: () => {},           // called when sheet is dismissed
 *       onSnap: (vh) => {},          // called after snapping to a height
 *       initialSnap: 50              // initial snap point (vh)
 *   });
 */

import state from "./state.js";

const CLOSE_VELOCITY = 0.4;   // px/ms — flick speed to dismiss
const MIN_DRAG_PX = 8;        // minimum movement before drag activates

export default class BottomSheet {
    constructor(panelEl, opts = {}) {
        this.panel = panelEl;
        this.snapPoints = (opts.snapPoints || [25, 50, 90]).sort((a, b) => a - b);
        this.onClose = opts.onClose || (() => {});
        this.onSnap = opts.onSnap || (() => {});
        this.initialSnap = opts.initialSnap || this.snapPoints[1] || 50;
        this.currentSnap = this.initialSnap;

        this._startY = 0;
        this._startTime = 0;
        this._startTranslate = 0;
        this._dragging = false;
        this._active = false;

        this._mql = window.matchMedia("(max-width: 600px)");

        // Find sub-elements
        this._handle = panelEl.querySelector(".drag-handle");
        this._header = panelEl.querySelector("[id$='-header']");
        this._body = panelEl.querySelector("[id$='-body']");

        // Bind methods
        this._onTouchStart = this._onTouchStart.bind(this);
        this._onTouchMove = this._onTouchMove.bind(this);
        this._onTouchEnd = this._onTouchEnd.bind(this);
        this._onMediaChange = this._onMediaChange.bind(this);

        // Observe panel open/close via MutationObserver
        this._observer = new MutationObserver(() => {
            if (!this._mql.matches) return;
            if (this.panel.classList.contains("open")) {
                this._snapTo(this.initialSnap, false);
            } else {
                // Panel was closed externally (e.g. close button) — clear inline transform
                this.panel.style.transform = "";
                document.documentElement.style.setProperty("--panel-visible-h", "0vh");
            }
        });
        this._observer.observe(this.panel, { attributes: true, attributeFilter: ["class"] });

        // Init based on current viewport
        this._onMediaChange();
        this._mql.addEventListener("change", this._onMediaChange);
    }

    _onMediaChange() {
        if (this._mql.matches) {
            this._activate();
        } else {
            this._deactivate();
        }
    }

    _activate() {
        if (this._active) return;
        this._active = true;

        const targets = [this._handle, this._header].filter(Boolean);
        targets.forEach(el => {
            el.addEventListener("touchstart", this._onTouchStart, { passive: true });
        });

        // Also allow drag from body when scrolled to top
        if (this._body) {
            this._body.addEventListener("touchstart", this._onTouchStart, { passive: true });
        }
    }

    _deactivate() {
        if (!this._active) return;
        this._active = false;

        const targets = [this._handle, this._header, this._body].filter(Boolean);
        targets.forEach(el => {
            el.removeEventListener("touchstart", this._onTouchStart);
        });

        // Reset any inline transform
        this.panel.style.transform = "";
        this.panel.classList.remove("panel-dragging");
    }

    _onTouchStart(e) {
        if (!this.panel.classList.contains("open")) return;

        const touch = e.touches[0];
        this._startY = touch.clientY;
        this._startTime = Date.now();
        this._dragging = false;
        this._dragActivated = false;
        this._touchTarget = e.currentTarget;

        // Calculate current translateY from panel position
        const panelH = this.panel.offsetHeight;
        const visibleH = (this.currentSnap / 100) * window.innerHeight;
        this._startTranslate = panelH - visibleH;

        document.addEventListener("touchmove", this._onTouchMove, { passive: false });
        document.addEventListener("touchend", this._onTouchEnd, { passive: true });
    }

    _onTouchMove(e) {
        const touch = e.touches[0];
        const deltaY = touch.clientY - this._startY;

        // Activate drag only after minimum movement
        if (!this._dragActivated) {
            if (Math.abs(deltaY) < MIN_DRAG_PX) return;

            // If touch started on body, only allow drag when scrolled to top and dragging down
            if (this._touchTarget === this._body) {
                if (this._body.scrollTop > 0 || deltaY < 0) {
                    this._cleanup();
                    return;
                }
            }
            this._dragActivated = true;
            this._dragging = true;
            this.panel.classList.add("panel-dragging");
        }

        e.preventDefault();

        const newTranslate = Math.max(0, this._startTranslate + deltaY);
        this.panel.style.transform = `translateY(${newTranslate}px)`;
    }

    _onTouchEnd(e) {
        this._cleanup();

        if (!this._dragging) return;
        this._dragging = false;
        this.panel.classList.remove("panel-dragging");

        const touch = e.changedTouches[0];
        const deltaY = touch.clientY - this._startY;
        const elapsed = Date.now() - this._startTime;
        const velocity = deltaY / Math.max(elapsed, 1);

        // Flick down fast → close
        if (velocity > CLOSE_VELOCITY) {
            this._close();
            return;
        }

        // Flick up fast → go to highest snap
        if (velocity < -CLOSE_VELOCITY) {
            this._snapTo(this.snapPoints[this.snapPoints.length - 1]);
            return;
        }

        // Calculate current visible vh based on where user released
        const panelH = this.panel.offsetHeight;
        const currentTranslate = this._startTranslate + deltaY;
        const visiblePx = panelH - currentTranslate;
        const visibleVh = (visiblePx / window.innerHeight) * 100;

        // If dragged below minimum snap, close
        if (visibleVh < this.snapPoints[0] * 0.5) {
            this._close();
            return;
        }

        // Snap to nearest point
        let nearest = this.snapPoints[0];
        let minDist = Infinity;
        for (const sp of this.snapPoints) {
            const dist = Math.abs(visibleVh - sp);
            if (dist < minDist) {
                minDist = dist;
                nearest = sp;
            }
        }
        this._snapTo(nearest);
    }

    _snapTo(vh, animate = true) {
        this.currentSnap = vh;
        const panelH = this.panel.offsetHeight;
        const visiblePx = (vh / 100) * window.innerHeight;
        const translateY = panelH - visiblePx;

        if (animate) {
            this.panel.classList.remove("panel-dragging");
        }
        this.panel.style.transform = `translateY(${Math.max(0, translateY)}px)`;

        // Update CSS variable for map adjustment
        document.documentElement.style.setProperty("--panel-visible-h", `${vh}vh`);

        if (state.map) {
            setTimeout(() => state.map.invalidateSize(), 300);
        }
        this.onSnap(vh);
    }

    _close() {
        this.panel.classList.remove("panel-dragging");
        this.panel.style.transform = "";
        document.documentElement.style.setProperty("--panel-visible-h", "0vh");
        this.onClose();
    }

    _cleanup() {
        document.removeEventListener("touchmove", this._onTouchMove);
        document.removeEventListener("touchend", this._onTouchEnd);
    }

    /** Call this when programmatically opening the panel to set initial snap. */
    open(snapVh) {
        if (!this._mql.matches) return;
        const vh = snapVh || this.initialSnap;
        this._snapTo(vh, false);
    }
}
