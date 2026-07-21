#!/usr/bin/env python3
"""Build a compact Berlin-only transit network from the official VBB GTFS feed."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path


BERLIN_STOP_PREFIX = "de:11000:"
BERLIN_BOUNDS = (52.28, 12.98, 52.72, 13.86)
MAX_SHAPES_PER_LINE = 14

MODE_BY_ROUTE_TYPE = {
    "0": "tram",
    "1": "subway",
    "2": "rail",
    "3": "bus",
    "4": "ferry",
    "100": "rail",
    "106": "rail",
    "109": "light_rail",
    "400": "subway",
    "700": "bus",
    "900": "tram",
    "1000": "ferry",
}

MODE_COLOR = {
    "subway": "#0067B1",
    "light_rail": "#008D4F",
    "tram": "#D71920",
    "bus": "#7C3AED",
    "rail": "#E11D48",
    "ferry": "#0284C7",
}


def rows(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as raw:
        yield from csv.DictReader((line.decode("utf-8-sig") for line in raw))


def point_segment_distance(point, start, end):
    lat_scale = 111_320
    lng_scale = lat_scale * math.cos(math.radians(52.52))
    px, py = point[1] * lng_scale, point[0] * lat_scale
    ax, ay = start[1] * lng_scale, start[0] * lat_scale
    bx, by = end[1] * lng_scale, end[0] * lat_scale
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if not length_sq:
        return math.hypot(px - ax, py - ay)
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(points, tolerance=18):
    if len(points) <= 2:
        return points
    max_distance = 0
    split = 0
    for index in range(1, len(points) - 1):
        distance = point_segment_distance(points[index], points[0], points[-1])
        if distance > max_distance:
            split, max_distance = index, distance
    if max_distance <= tolerance:
        return [points[0], points[-1]]
    left = simplify(points[: split + 1], tolerance)
    right = simplify(points[split:], tolerance)
    return left[:-1] + right


def in_bounds(point, padding=0.02):
    min_lat, min_lng, max_lat, max_lng = BERLIN_BOUNDS
    return (
        min_lat - padding <= point[0] <= max_lat + padding
        and min_lng - padding <= point[1] <= max_lng + padding
    )


def clip_to_berlin(points):
    runs = []
    run = []
    for point in points:
        if in_bounds(point):
            run.append(point)
        else:
            if len(run) >= 2:
                runs.append(run)
            run = []
    if len(run) >= 2:
        runs.append(run)
    return runs


def bbox(polylines):
    points = [point for polyline in polylines for point in polyline]
    return [
        min(point[0] for point in points),
        min(point[1] for point in points),
        max(point[0] for point in points),
        max(point[1] for point in points),
    ]


def clean_stop_name(name):
    return re.sub(r"\s*\(Berlin\)\s*$", "", name).strip()


def text_color(background):
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", background):
        return "#FFFFFF"
    red, green, blue = (int(background[i : i + 2], 16) for i in (1, 3, 5))
    luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
    return "#111827" if luminance > 0.68 else "#FFFFFF"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("gtfs", type=Path)
    parser.add_argument("output", type=Path, nargs="?", default=Path("public/berlin-transit.json"))
    args = parser.parse_args()

    with zipfile.ZipFile(args.gtfs) as zf:
        route_rows = {}
        for route in rows(zf, "routes.txt"):
            mode = MODE_BY_ROUTE_TYPE.get(route["route_type"])
            if mode:
                route_rows[route["route_id"]] = {**route, "mode": mode}

        stops = {}
        for stop in rows(zf, "stops.txt"):
            if not stop["stop_id"].startswith(BERLIN_STOP_PREFIX):
                continue
            try:
                point = [round(float(stop["stop_lat"]), 6), round(float(stop["stop_lon"]), 6)]
            except ValueError:
                continue
            stops[stop["stop_id"]] = {
                "id": stop["stop_id"],
                "name": clean_stop_name(stop["stop_name"]),
                "point": point,
                "parent": stop.get("parent_station") or "",
                "locationType": stop.get("location_type") or "0",
            }

        def canonical_stop(stop_id):
            stop = stops[stop_id]
            parent_id = stop["parent"]
            return stops.get(parent_id, stop)

        trips = {}
        for trip in rows(zf, "trips.txt"):
            route_id = trip["route_id"]
            if route_id not in route_rows or not trip.get("shape_id"):
                continue
            trips[trip["trip_id"]] = {
                "route": route_id,
                "shape": trip["shape_id"],
                "headsign": trip.get("trip_headsign", ""),
            }

        route_stops = defaultdict(dict)
        shape_routes = {}
        shape_heads = defaultdict(Counter)
        shape_endpoints = {}
        trip_first_stop = {}
        trip_last_stop = {}

        for stop_time in rows(zf, "stop_times.txt"):
            trip_id = stop_time["trip_id"]
            stop_id = stop_time["stop_id"]
            trip = trips.get(trip_id)
            if not trip or stop_id not in stops:
                continue
            stop = canonical_stop(stop_id)
            route_id = trip["route"]
            route_stops[route_id][stop["id"]] = stop
            shape_routes[trip["shape"]] = route_id
            if trip["headsign"]:
                shape_heads[trip["shape"]][clean_stop_name(trip["headsign"])] += 1
            trip_first_stop.setdefault(trip_id, stop["id"])
            trip_last_stop[trip_id] = stop["id"]

        for trip_id, first_stop in trip_first_stop.items():
            trip = trips[trip_id]
            shape_endpoints.setdefault(trip["shape"], (first_stop, trip_last_stop[trip_id]))

        selected_shapes = set(shape_routes)
        shape_points = defaultdict(list)
        for point in rows(zf, "shapes.txt"):
            shape_id = point["shape_id"]
            if shape_id not in selected_shapes:
                continue
            shape_points[shape_id].append(
                [round(float(point["shape_pt_lat"]), 6), round(float(point["shape_pt_lon"]), 6)]
            )

        shapes_by_route = defaultdict(list)
        for shape_id, points in shape_points.items():
            polylines = [simplify(run) for run in clip_to_berlin(points)]
            polylines = [polyline for polyline in polylines if len(polyline) >= 2]
            if not polylines:
                continue
            point_count = sum(len(polyline) for polyline in polylines)
            first_stop, last_stop = shape_endpoints.get(shape_id, ("", ""))
            headsign = shape_heads[shape_id].most_common(1)[0][0] if shape_heads[shape_id] else ""
            signature = tuple(
                (round(polyline[0][0], 4), round(polyline[0][1], 4), round(polyline[-1][0], 4), round(polyline[-1][1], 4))
                for polyline in polylines
            )
            shapes_by_route[shape_routes[shape_id]].append(
                {
                    "id": shape_id,
                    "polylines": polylines,
                    "pointCount": point_count,
                    "endpointKey": (first_stop, last_stop),
                    "signature": signature,
                    "headsign": headsign,
                }
            )

        grouped_lines = defaultdict(list)
        for route_id, candidates in shapes_by_route.items():
            route = route_rows[route_id]
            key = (route["mode"], route["route_short_name"] or route_id)
            grouped_lines[key].append((route_id, route, candidates))

        output_lines = []
        for (mode, ref), route_groups in grouped_lines.items():
            all_candidates = []
            all_stops = {}
            names = []
            colors = []
            for route_id, route, candidates in route_groups:
                all_candidates.extend(candidates)
                all_stops.update(route_stops[route_id])
                if route["route_long_name"]:
                    names.append(route["route_long_name"])
                if route["route_color"]:
                    colors.append("#" + route["route_color"].upper())

            # Prefer broad, distinct variants while capping pathological timetable variations.
            chosen = []
            endpoint_counts = Counter()
            signatures = set()
            for candidate in sorted(all_candidates, key=lambda item: item["pointCount"], reverse=True):
                if candidate["signature"] in signatures:
                    continue
                endpoint_key = candidate["endpointKey"]
                if endpoint_key != ("", "") and endpoint_counts[endpoint_key] >= 2:
                    continue
                chosen.append(candidate)
                signatures.add(candidate["signature"])
                endpoint_counts[endpoint_key] += 1
                if len(chosen) >= MAX_SHAPES_PER_LINE:
                    break

            polylines = []
            for candidate in chosen:
                polylines.extend(candidate["polylines"])
            if not polylines:
                continue

            color = colors[0] if colors else MODE_COLOR[mode]
            output_lines.append(
                {
                    "id": f"{mode}:{ref}",
                    "mode": mode,
                    "ref": ref,
                    "name": Counter(names).most_common(1)[0][0] if names else ref,
                    "color": color,
                    "textColor": text_color(color),
                    "polylines": polylines,
                    "polylineBboxes": [bbox([polyline]) for polyline in polylines],
                    "bbox": bbox(polylines),
                    "stops": sorted(
                        (
                            {"id": stop["id"], "name": stop["name"], "point": stop["point"]}
                            for stop in all_stops.values()
                        ),
                        key=lambda stop: stop["name"],
                    ),
                }
            )

        mode_order = {"subway": 0, "light_rail": 1, "tram": 2, "bus": 3, "rail": 4, "ferry": 5}
        output_lines.sort(key=lambda line: (mode_order[line["mode"]], line["ref"]))
        source_date = max(zf.getinfo(name).date_time for name in zf.namelist())[:3]
        payload = {
            "source": "VBB GTFS",
            "sourceUrl": "https://unternehmen.vbb.de/digitale-services/datensaetze/",
            "sourceUpdatedAt": "-".join(str(part).zfill(2) for part in source_date),
            "license": "CC BY 4.0",
            "lines": output_lines,
        }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(output_lines)} lines to {args.output}")


if __name__ == "__main__":
    main()
