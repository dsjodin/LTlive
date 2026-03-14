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
