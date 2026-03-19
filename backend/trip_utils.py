"""Utilities for merging GTFS-RT and GTFS static departure data.

Imported by app.py and Blueprint modules that need departure merging logic.
"""

# How many seconds either side of an RT departure time to suppress a static
# entry that lacks a matching trip_id (handles version-skew between feeds).
RT_STATIC_WINDOW = 20 * 60  # seconds


def merge_rt_static(rt_deps, static_deps):
    """Merge RT and static departures for one stop.

    RT entries take precedence.  A static entry is suppressed if:
      - its trip_id matches an RT entry, OR
      - its scheduled time is within RT_STATIC_WINDOW seconds of any RT
        departure (handles delayed/early trips where the GTFS-RT trip_id or
        route_id format differs from the static GTFS data).

    RT entries are annotated with "sched_time" (the static GTFS scheduled
    time) so that callers can show the original scheduled time alongside the
    realtime time even when they differ.
    """
    if not rt_deps:
        return list(static_deps)

    # Build trip_id → static scheduled time so we can annotate RT entries
    static_by_trip: dict[str, int] = {d["trip_id"]: d["time"] for d in static_deps}

    rt_trip_ids = set()
    annotated_rt = []
    for dep in rt_deps:
        trip_id = dep["trip_id"]
        rt_trip_ids.add(trip_id)
        sched = static_by_trip.get(trip_id)
        annotated_rt.append({**dep, "sched_time": sched} if sched is not None else dep)

    rt_times = [d["time"] for d in annotated_rt]

    filtered_static = []
    for dep in static_deps:
        if dep["trip_id"] in rt_trip_ids:
            continue
        dep_time = dep["time"]
        if any(abs(dep_time - rt_time) <= RT_STATIC_WINDOW for rt_time in rt_times):
            continue
        filtered_static.append(dep)

    return annotated_rt + filtered_static
