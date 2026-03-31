/**
 * LTlive — Linjekonfiguration
 *
 * Dessa värden är defaults som används tills /api/status svarar med
 * den centraliserade konfigurationen från admin-interfacet.
 *
 * Redigera via /admin.html istället för att ändra här.
 */

/* eslint-disable no-unused-vars */

let LINE_CONFIG = {
    stadstrafiken: ["1", "2", "3", "4", "5", "6", "7"],
    lansbuss: [
        "200", "230",
        "300", "308", "314", "324", "351",
        "400", "401", "403", "406", "420", "430", "431", "490",
        "500", "502", "506", "520", "590", "593",
        "600", "620", "630",
        "700", "701", "710",
        "800", "807", "819", "820", "840",
    ],
    tag_i_bergslagen: [
        "3190", "3223", "3231", "3234", "3235",
        "9005", "9006", "9007", "9008", "9009",
        "9011", "9012", "9013", "9014", "9015",
        "9018", "9019", "9020", "9021", "9022",
        "9023", "9024", "9025", "9037", "9039",
        "9056", "9057", "9068",
    ],
};

let ALLOWED_LINE_NUMBERS = new Set([
    ...LINE_CONFIG.stadstrafiken,
    ...LINE_CONFIG.lansbuss,
]);

let ALLOWED_TRAIN_IDS = new Set(LINE_CONFIG.tag_i_bergslagen);

let LINE_COLORS_CUSTOM = {
    "1": { bg: "5B2D8E", text: "FFFFFF" },
    "2": { bg: "2E8B3A", text: "FFFFFF" },
    "3": { bg: "E87722", text: "FFFFFF" },
    "4": { bg: "1A7A7A", text: "FFFFFF" },
    "5": { bg: "1565C0", text: "FFFFFF" },
    "6": { bg: "F5C800", text: "1C1C1E" },
    "7": { bg: "D4607A", text: "FFFFFF" },
    lansbuss: { bg: "7B5C3E", text: "FFFFFF" },
};

/**
 * Apply server-side config from /api/status to override the defaults above.
 * Called by app.js after fetching the status endpoint.
 */
function applyServerConfig(status) {
    if (status.lines) {
        const l = status.lines;
        LINE_CONFIG = {
            stadstrafiken: l.stadstrafiken || LINE_CONFIG.stadstrafiken,
            lansbuss: l.lansbuss || LINE_CONFIG.lansbuss,
            tag_i_bergslagen: l.tag_i_bergslagen || LINE_CONFIG.tag_i_bergslagen,
        };
        // Only override Sets if the server provided non-empty arrays
        const stads = LINE_CONFIG.stadstrafiken;
        const lans = LINE_CONFIG.lansbuss;
        if (stads.length || lans.length) {
            ALLOWED_LINE_NUMBERS = new Set([...stads, ...lans]);
        }
        const trains = LINE_CONFIG.tag_i_bergslagen;
        if (trains.length) {
            ALLOWED_TRAIN_IDS = new Set(trains);
        }
    }
    if (status.line_colors && Object.keys(status.line_colors).length > 0) {
        LINE_COLORS_CUSTOM = status.line_colors;
    }
}
