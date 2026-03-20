/**
 * utils.js — Shared UI utilities for LTlive board pages.
 *
 * Import only what you need:
 *   import { updateClock } from './modules/utils.js';
 */

/**
 * Update an element's text content with the current time (sv-SE locale).
 * @param {HTMLElement} el
 */
export function updateClock(el) {
    el.textContent = new Date().toLocaleTimeString("sv-SE");
}
