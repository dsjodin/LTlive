/**
 * colors.js — Route color utilities.
 *
 * Provides consistent line badge colours, pulling from config.js globals
 * (LINE_CONFIG, LINE_COLORS_CUSTOM) and falling back to GTFS colours or
 * a deterministic hash palette.
 */

/* global LINE_CONFIG, LINE_COLORS_CUSTOM */

const LINE_COLORS = [
    "E63946", "457B9D", "2A9D8F", "E9C46A", "F4A261",
    "264653", "6A0572", "AB83A1", "118AB2", "073B4C",
    "D62828", "F77F00", "FCBF49", "2EC4B6", "011627",
    "FF6B6B", "4ECDC4", "45B7D1", "96CEB4", "FFEAA7",
];

export function getLineStyle(shortName) {
    if (typeof LINE_COLORS_CUSTOM !== "undefined" && LINE_COLORS_CUSTOM[shortName])
        return LINE_COLORS_CUSTOM[shortName];
    if (typeof LINE_CONFIG !== "undefined" && typeof LINE_COLORS_CUSTOM !== "undefined"
        && LINE_CONFIG.lansbuss && LINE_CONFIG.lansbuss.includes(shortName))
        return LINE_COLORS_CUSTOM.lansbuss;
    return null;
}

export function getRouteColor(route) {
    const custom = getLineStyle(route.route_short_name);
    if (custom) return `#${custom.bg}`;
    if (route.route_color && route.route_color !== "000000") {
        return `#${route.route_color}`;
    }
    const name = route.route_short_name || route.route_id;
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return `#${LINE_COLORS[Math.abs(hash) % LINE_COLORS.length]}`;
}

export function getRouteTextColor(route) {
    const custom = getLineStyle(route.route_short_name);
    if (custom) return `#${custom.text}`;
    return route.route_text_color ? `#${route.route_text_color}` : "#fff";
}

/**
 * Apply data-bg / data-fg attributes as inline styles.
 * Used instead of style="" in HTML to comply with strict CSP.
 */
export function applyBadgeColors(container) {
    container.querySelectorAll("[data-bg]").forEach(el => {
        el.style.background = el.dataset.bg.startsWith("#") ? el.dataset.bg : `#${el.dataset.bg}`;
        if (el.dataset.fg) el.style.color = el.dataset.fg.startsWith("#") ? el.dataset.fg : `#${el.dataset.fg}`;
    });
}
