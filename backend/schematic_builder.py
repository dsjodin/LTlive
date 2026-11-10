"""Generate a schematic network map model (nodes, edges, patterns) from GTFS static data.

The model is the single source for both the map editor and the live map:
nodes carry their GTFS stop_ids and lat/lon, edges list the lines that run
between two consecutive stops. Positions are a rough octilinear start layout
that is meant to be refined by hand in schematic-editor.html.
"""

import math
from collections import Counter, defaultdict

import gtfs_loader

CANVAS_W, CANVAS_H = 2481, 3508   # same coordinate space as lt_karta.svg
MARGIN = 120
GRID = 10
MIN_PATTERN_SHARE = 0.05          # stop patterns below this share of a line+direction are ignored
NAME_MERGE_M = 500                # stops with the same name closer than this become one node

# Colours from the hand-drawn city map (lt_karta.svg)
DEFAULT_COLORS = {
    "1": "#421e55", "2": "#57aa35", "3": "#f04752", "4": "#456670",
    "5": "#26538f", "6": "#f58232", "7": "#b27ac3",
}


def line_sort_key(name):
    return (0, int(name), "") if name.isdigit() else (1, 0, name)


def _dist_m(lat1, lon1, lat2, lon2):
    x = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2)) * 111320
    y = (lat2 - lat1) * 110540
    return math.hypot(x, y)


def _layout(nodes, edges):
    """Project lat/lon to the canvas, pull edges towards 0/45/90 degrees, snap to grid."""
    lat0 = sum(n["lat"] for n in nodes.values()) / len(nodes)
    k = math.cos(math.radians(lat0))
    pos = {nid: [n["lon"] * k, -n["lat"]] for nid, n in nodes.items()}

    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    w, h = max(xs) - min(xs) or 1e-9, max(ys) - min(ys) or 1e-9
    scale = min((CANVAS_W - 2 * MARGIN) / w, (CANVAS_H - 2 * MARGIN) / h)
    ox = (CANVAS_W - w * scale) / 2
    oy = (CANVAS_H - h * scale) / 2
    for p in pos.values():
        p[0] = ox + (p[0] - min(xs)) * scale
        p[1] = oy + (p[1] - min(ys)) * scale

    step = math.pi / 4
    for _ in range(80):
        disp = defaultdict(lambda: [0.0, 0.0, 0])
        for e in edges:
            a, b = pos[e["a"]], pos[e["b"]]
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            if length == 0:
                continue
            ang = round(math.atan2(dy, dx) / step) * step
            cx = (math.cos(ang) * length - dx) / 2
            cy = (math.sin(ang) * length - dy) / 2
            da, db = disp[e["a"]], disp[e["b"]]
            da[0] -= cx; da[1] -= cy; da[2] += 1
            db[0] += cx; db[1] += cy; db[2] += 1
        for nid, (dx, dy, n) in disp.items():
            pos[nid][0] += 0.5 * dx / n
            pos[nid][1] += 0.5 * dy / n

    taken = set()
    for nid in sorted(pos):
        gx, gy = round(pos[nid][0] / GRID), round(pos[nid][1] / GRID)
        r = 0
        while True:
            free = [(gx + i, gy + j) for i in range(-r, r + 1) for j in range(-r, r + 1)
                    if max(abs(i), abs(j)) == r and (gx + i, gy + j) not in taken]
            if free:
                gx, gy = free[0]
                break
            r += 1
        taken.add((gx, gy))
        nodes[nid]["x"] = gx * GRID
        nodes[nid]["y"] = gy * GRID


def build_schematic(line_names):
    """Return a schematic model dict for the given route_short_names, or None if no data."""
    line_names = [str(n) for n in line_names]
    routes = gtfs_loader.load_routes()
    route_line = {
        rid: r["route_short_name"] for rid, r in routes.items()
        if r["route_short_name"] in line_names
        and (r["route_type"] == 3 or 700 <= r["route_type"] <= 799)
    }
    if not route_line:
        return None

    trips = {tid: t for tid, t in gtfs_loader.load_trips().items() if t["route_id"] in route_line}
    stop_times = gtfs_loader.load_stop_times_for_trips(set(trips))
    stops = gtfs_loader.load_stops()

    counts = defaultdict(Counter)
    for tid, sts in stop_times.items():
        t = trips[tid]
        key = (route_line[t["route_id"]], t["direction_id"] or "0")
        counts[key][tuple(s["stop_id"] for s in sts)] += 1

    raw_patterns = []
    for (line, direction), c in counts.items():
        total = sum(c.values())
        for i, (seq, n) in enumerate(c.most_common()):
            if i > 0 and n / total < MIN_PATTERN_SHARE:
                break
            raw_patterns.append((line, direction, n, seq))

    # Group stops into nodes: parent_station, otherwise same name within NAME_MERGE_M
    node_of_stop, nodes, by_name = {}, {}, defaultdict(list)
    used = sorted({sid for *_, seq in raw_patterns for sid in seq})
    for sid in used:
        s = stops.get(sid)
        if not s:
            continue
        parent = s["parent_station"]
        if parent:
            nid, name = parent, stops.get(parent, s)["stop_name"]
        else:
            name, nid = s["stop_name"], None
            for cand in by_name[name]:
                c = nodes[cand]
                if _dist_m(c["_lat"][0], c["_lon"][0], s["stop_lat"], s["stop_lon"]) < NAME_MERGE_M:
                    nid = cand
                    break
            if nid is None:
                nid = sid
                by_name[name].append(nid)
        node = nodes.setdefault(nid, {"name": name, "stop_ids": [], "_lat": [], "_lon": []})
        node["stop_ids"].append(sid)
        node["_lat"].append(s["stop_lat"])
        node["_lon"].append(s["stop_lon"])
        node_of_stop[sid] = nid

    if not nodes:
        return None
    for node in nodes.values():
        node["lat"] = round(sum(node["_lat"]) / len(node["_lat"]), 6)
        node["lon"] = round(sum(node["_lon"]) / len(node["_lon"]), 6)
        del node["_lat"], node["_lon"]
        node["label"] = {"dx": 14, "dy": 6, "anchor": "start"}

    patterns, edge_lines = [], defaultdict(set)
    for line, direction, n, seq in raw_patterns:
        path = []
        for sid in seq:
            nid = node_of_stop.get(sid)
            if nid and (not path or path[-1] != nid):
                path.append(nid)
        for a, b in zip(path, path[1:]):
            edge_lines[tuple(sorted((a, b)))].add(line)
        patterns.append({"line": line, "direction": int(direction), "trips": n, "nodes": path})

    edges = [
        {"a": a, "b": b, "lines": sorted(ls, key=line_sort_key), "bends": []}
        for (a, b), ls in sorted(edge_lines.items())
    ]
    _layout(nodes, edges)

    lines = {}
    for rid, ln in route_line.items():
        color = DEFAULT_COLORS.get(ln) or "#" + (routes[rid]["route_color"] or "0074D9")
        lines.setdefault(ln, {"color": color, "text": "#ffffff"})

    return {
        "version": 1,
        "width": CANVAS_W,
        "height": CANVAS_H,
        "lines": dict(sorted(lines.items(), key=lambda kv: line_sort_key(kv[0]))),
        "nodes": nodes,
        "edges": edges,
        "patterns": patterns,
    }
