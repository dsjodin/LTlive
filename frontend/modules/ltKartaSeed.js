/**
 * ltKartaSeed.js - align the editor map with the hand-drawn lt_karta.svg (viewBox 0 0 2481 3508).
 * The background never moves: the user picks control points (stop on the map + same stop in the
 * background) and the map is transformed onto the background; stops can then be moved onto
 * the background's stop circles.
 */

export const SVG_STOP_CIRCLES = [
  [401.2,2140.9],[436.7,1949.0],[461.7,1977.9],[462.4,1679.4],[495.9,2010.4],
  [531.6,2045.4],[536.3,2217.4],[558.0,2243.7],[565.9,2080.5],[577.2,1723.1],
  [588.7,2274.4],[601.3,2115.5],[620.2,1765.4],[625.4,2310.7],[631.5,2143.2],
  [655.3,1800.5],[666.1,2326.8],[696.4,1842.2],[713.0,2143.2],[739.4,1884.9],
  [744.1,2659.1],[744.1,2728.5],[744.1,2758.6],[744.1,2827.0],[744.1,2940.4],
  [744.1,3016.0],[744.1,3057.1],[744.1,3138.7],[758.9,2883.6],[759.0,2969.8],
  [772.0,2327.0],[787.0,2143.9],[793.6,1905.6],[797.7,2970.1],[804.2,2596.1],
  [813.9,1553.0],[820.1,3270.9],[823.0,3343.5],[839.3,3133.5],[841.5,3034.0],
  [841.8,3004.2],[861.4,2143.9],[872.9,2327.0],[879.0,2842.2],[893.3,1563.3],
  [898.8,1905.6],[902.4,2595.8],[934.5,2143.9],[948.2,2327.0],[954.7,1637.7],
  [954.7,1678.1],[966.5,1896.2],[966.5,1921.9],[980.2,1263.9],[980.4,1345.5],
  [980.4,1392.8],[980.4,1440.3],[980.4,1481.3],[984.0,1300.0],[1000.2,2596.6],
  [1000.2,2842.2],[1032.7,2327.0],[1064.5,871.5],[1073.8,2041.7],[1085.9,2041.7],
  [1094.9,2112.0],[1097.7,2018.6],[1097.7,2597.4],[1098.5,2041.7],[1104.9,2425.5],
  [1104.9,2479.9],[1108.9,870.5],[1114.7,2210.8],[1122.5,2842.2],[1122.9,2018.6],
  [1125.0,2041.7],[1128.0,2112.4],[1137.7,2489.0],[1141.1,2210.8],[1143.0,2082.1],
  [1162.3,1242.5],[1167.1,1176.2],[1168.0,2041.7],[1174.0,2489.0],[1178.6,2831.8],
  [1179.0,2240.1],[1187.3,2210.8],[1191.4,1304.3],[1200.8,863.7],[1201.0,2489.0],
  [1220.7,2210.8],[1224.5,2875.1],[1224.5,2941.9],[1242.1,2240.5],[1243.4,2210.8],
  [1246.2,910.4],[1246.2,952.4],[1246.2,997.7],[1246.2,1038.2],[1246.2,1081.4],
  [1246.2,1166.2],[1246.2,1210.5],[1246.2,1253.7],[1246.2,1389.5],[1246.2,1457.0],
  [1246.2,1527.2],[1246.2,1627.6],[1246.2,1705.7],[1248.1,2830.6],[1262.8,2799.4],
  [1262.9,2592.5],[1270.6,2516.2],[1285.1,1751.6],[1322.6,1304.1],[1330.5,2068.1],
  [1330.5,2213.0],[1330.5,2295.2],[1332.3,2423.0],[1343.1,2213.0],[1343.2,2068.1],
  [1343.3,2295.2],[1343.7,2423.2],[1358.4,1847.1],[1358.5,1883.9],[1362.1,2038.4],
  [1366.7,1792.7],[1382.6,1760.7],[1386.3,1520.9],[1386.3,1580.3],[1386.3,1644.5],
  [1386.3,1676.7],[1386.3,1708.9],[1386.3,1735.6],[1420.9,2353.8],[1427.6,2740.3],
  [1429.4,2518.6],[1429.4,2559.2],[1430.1,2602.0],[1430.1,2637.5],[1430.1,2687.3],
  [1440.7,1324.3],[1440.7,1356.0],[1440.7,1388.1],[1440.7,1419.5],[1440.7,1452.4],
  [1440.7,1499.3],[1538.3,2761.3],[1583.4,2342.2],[1583.4,2353.6],[1585.8,1878.2],
  [1629.4,1925.6],[1658.6,2704.3],[1672.7,1959.0],[1693.5,1772.0],[1745.2,2342.3],
  [1745.2,2353.7],[1749.7,1921.9],[1772.9,1725.6],[1809.0,2631.2],[1824.5,1925.3],
  [1844.5,2628.0],[1893.8,2342.3],[1893.8,2353.6],[1919.8,1925.3],[1923.0,2470.6],
  [1923.0,2605.0],[1923.1,2785.2],[1923.1,2840.4],[1923.1,2894.5],[1925.2,3009.4],
  [1934.3,2470.6],[1936.4,2612.4],[1953.4,2612.4],[1959.8,2219.9],[1960.9,2040.5],
  [1967.6,2768.4],[1999.2,2604.4],[2003.4,2768.4],[2011.7,2756.9],[2090.0,2312.0],
  [2115.7,2603.3],[2142.1,2653.3],[2174.1,2380.6],[2174.1,2424.7],[2174.1,2473.9],
  [2174.1,2515.0],
];

/** Least-squares affine coefficients [cx, cy] for src -> dst, or null with fewer than 3 usable pairs. */
export function affineCoeffs(src, dst) {
  if (src.length < 3) return null;
  const solve = (vals) => {
    const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    src.forEach(([x, y], i) => {
      const r = [x, y, 1];
      for (let j = 0; j < 3; j++) { b[j] += r[j] * vals[i]; for (let k = 0; k < 3; k++) a[j][k] += r[j] * r[k]; }
    });
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const d = det(a);
    if (Math.abs(d) < 1e-9) return null;
    return [0, 1, 2].map(c => det(a.map((row, j) => row.map((v, k) => (k === c ? b[j] : v)))) / d);
  };
  const cx = solve(dst.map(p => p[0])), cy = solve(dst.map(p => p[1]));
  return cx && cy ? [cx, cy] : null;
}

/** Least-squares affine map src -> dst ([[x,y],...]); identity when it cannot be fitted. */
export function fitAffine(src, dst) {
  const c = affineCoeffs(src, dst);
  if (!c) return (p) => p;
  const [cx, cy] = c;
  return ([x, y]) => [cx[0] * x + cx[1] * y + cx[2], cy[0] * x + cy[1] * y + cy[2]];
}

// SVG matrix(a b c d e f): x' = a x + c y + e, y' = b x + d y + f
export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function applyMatrix(m, [x, y]) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertMatrix(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** Least-squares similarity (scale, rotation, move, no skew) for pairs [[sx, sy], [dx, dy]]; null if < 2 distinct points. */
export function similarityMatrix(pairs) {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  const zx = pairs.reduce((a, p) => a + p[0][0], 0) / n, zy = pairs.reduce((a, p) => a + p[0][1], 0) / n;
  const wx = pairs.reduce((a, p) => a + p[1][0], 0) / n, wy = pairs.reduce((a, p) => a + p[1][1], 0) / n;
  let nr = 0, ni = 0, den = 0;
  for (const [[sx, sy], [dx, dy]] of pairs) {
    const ax = sx - zx, ay = sy - zy, bx = dx - wx, by = dy - wy;
    nr += bx * ax + by * ay;
    ni += by * ax - bx * ay;
    den += ax * ax + ay * ay;
  }
  if (den < 1e-9) return null;
  const ar = nr / den, ai = ni / den;
  return [ar, ai, -ai, ar, wx - (ar * zx - ai * zy), wy - (ai * zx + ar * zy)];
}

/**
 * Rubber-sheet warp from control pairs [[sx, sy], [dx, dy]]: a similarity fit of all pairs plus a
 * local correction (inverse distance weighted residuals), so every control point lands exactly
 * on its target and the map around it follows. More points only make it fit better.
 */
export function makeWarp(pairs) {
  if (!pairs.length) return (p) => p;
  const m = similarityMatrix(pairs)
    || [1, 0, 0, 1, pairs[0][1][0] - pairs[0][0][0], pairs[0][1][1] - pairs[0][0][1]];
  const res = pairs.map(([src, dst]) => {
    const [x, y] = applyMatrix(m, src);
    return [src, dst[0] - x, dst[1] - y];
  });
  return ([x, y]) => {
    const [bx, by] = applyMatrix(m, [x, y]);
    let sw = 0, rx = 0, ry = 0;
    for (const [[sx, sy], ex, ey] of res) {
      const d2 = (x - sx) ** 2 + (y - sy) ** 2;
      if (d2 < 1e-6) return [bx + ex, by + ey];
      const w = 1 / d2;
      sw += w; rx += w * ex; ry += w * ey;
    }
    return [bx + rx / sw, by + ry / sw];
  };
}

/**
 * Move stops onto the nearest background circle (each circle used once, closest pairs first,
 * within maxDist). Other stops and all bends follow a warp of the moved ones.
 * Returns the number of stops placed on a circle.
 */
export function snapNodesToCircles(model, maxDist) {
  const circles = SVG_STOP_CIRCLES;
  const cands = [];
  for (const [id, n] of Object.entries(model.nodes)) {
    circles.forEach((c, ci) => {
      const d = Math.hypot(c[0] - n.x, c[1] - n.y);
      if (d <= maxDist) cands.push([d, id, ci]);
    });
  }
  cands.sort((a, b) => a[0] - b[0]);
  const match = {}, usedCircle = new Set();
  for (const [, id, ci] of cands) {
    if (match[id] || usedCircle.has(ci)) continue;
    match[id] = circles[ci];
    usedCircle.add(ci);
  }

  const ids = Object.keys(match);
  const move = makeWarp(ids.map(id => [[model.nodes[id].x, model.nodes[id].y], match[id]]));
  for (const [id, n] of Object.entries(model.nodes)) {
    const [x, y] = match[id] || move([n.x, n.y]);
    n.x = Math.round(x); n.y = Math.round(y);
  }
  for (const e of model.edges) e.bends = (e.bends || []).map(b => move(b).map(Math.round));
  return ids.length;
}

/** Move every stop and bend of the map with fn([x, y]) -> [x, y]. */
export function transformMap(model, fn) {
  for (const n of Object.values(model.nodes)) {
    const [x, y] = fn([n.x, n.y]);
    n.x = Math.round(x); n.y = Math.round(y);
  }
  for (const e of model.edges) e.bends = (e.bends || []).map(b => fn(b).map(Math.round));
}
