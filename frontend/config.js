/**
 * LTlive - Linjekonfiguration
 *
 * Lägg till eller ta bort linjenummer för att styra vilka linjer som
 * visas på kartan (bussar, linjesträckningar och hållplatser).
 *
 * Lämna en grupp tom ([]) för att inte visa några linjer ur den gruppen.
 */

const LINE_CONFIG = {
    // Stadstrafiken Örebro
    stadstrafiken: ["1", "2", "3", "4", "5", "6", "7"],

    // Länstrafiken Örebro - Länsbuss
    lansbuss: [
        "200", "230",
        "300", "308", "314", "324", "351",
        "400", "401", "403", "406", "420", "430", "431", "490",
        "500", "502", "506", "520", "590", "593",
        "600", "620", "630",
        "700", "701", "710",
        "800", "807", "819", "820", "840",
    ],
};

// Flat Set of all allowed route_short_name values — used for fast lookup
const ALLOWED_LINE_NUMBERS = new Set([
    ...LINE_CONFIG.stadstrafiken,
    ...LINE_CONFIG.lansbuss,
]);

/**
 * Custom colors per line (overrides GTFS colors).
 * Keys are route_short_name, values are { bg, text } hex strings (without #).
 * Use "lansbuss" as a fallback for all Länsbuss routes not listed individually.
 */
const LINE_COLORS_CUSTOM = {
    // Stadstrafiken
    "1": { bg: "5B2D8E", text: "FFFFFF" }, // Mörklila
    "2": { bg: "2E8B3A", text: "FFFFFF" }, // Grön
    "3": { bg: "E87722", text: "FFFFFF" }, // Orange
    "4": { bg: "1A7A7A", text: "FFFFFF" }, // Petrol
    "5": { bg: "1565C0", text: "FFFFFF" }, // Blå
    "6": { bg: "F5C800", text: "1C1C1E" }, // Gul (mörk text för läsbarhet)
    "7": { bg: "D4607A", text: "FFFFFF" }, // Rosa
    // Länsbuss fallback — används för alla länsbusslinjer
    lansbuss: { bg: "7B5C3E", text: "FFFFFF" }, // Brun
};
