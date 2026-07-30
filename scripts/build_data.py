#!/usr/bin/env python3
"""Regenerate the Texas county boundary data used by the site.

Source: U.S. Census Bureau cartographic boundary files (1:500,000), which are
public domain. We download the national county file, keep only Texas
(STATEFP 48), thin the coordinates, and write:

  data/tx-counties.geojson  - boundaries + label anchor points (generated)
  data/counties.csv         - fips, name, description (descriptions preserved)

The CSV is the editable file: existing descriptions are never overwritten, and
new counties are appended with an empty description.

Usage:
  python scripts/build_data.py
  python scripts/build_data.py --year 2023 --precision 4

Requires: geopandas (pip install -r scripts/requirements.txt)
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = Path(__file__).resolve().parent / ".cache"

TEXAS_STATEFP = "48"
URL = "https://www2.census.gov/geo/tiger/GENZ{year}/shp/cb_{year}_us_county_500k.zip"


def download(year: int) -> Path:
    CACHE.mkdir(exist_ok=True)
    dest = CACHE / f"cb_{year}_us_county_500k.zip"
    if dest.exists():
        print(f"using cached {dest.relative_to(ROOT)}")
        return dest
    url = URL.format(year=year)
    print(f"downloading {url}")
    with urllib.request.urlopen(url) as resp, dest.open("wb") as fh:
        fh.write(resp.read())
    print(f"  saved {dest.stat().st_size / 1e6:.1f} MB")
    return dest


def thin(ring, precision: int) -> list[list[float]]:
    """Round coordinates to a fixed grid and drop repeated points.

    Rounding is a shared-vertex-safe operation: two counties that share a
    border share the same input vertices, so they round identically and no
    gaps open up between them. Douglas-Peucker style simplification would
    not have that property.
    """
    pts = [(round(x, precision), round(y, precision)) for x, y in ring]
    out: list[tuple[float, float]] = []
    for p in pts:
        if not out or out[-1] != p:
            out.append(p)
    if out[0] != out[-1]:
        out.append(out[0])
    return [list(p) for p in out]


def label_point(geom) -> list[float]:
    """A point inside the county, for label placement.

    The centroid looks best but falls outside concave counties, so it is only
    used when it actually lands on the polygon; otherwise fall back to a
    representative point, which is guaranteed to be inside.
    """
    largest = geom
    if geom.geom_type == "MultiPolygon":
        largest = max(geom.geoms, key=lambda g: g.area)
    point = largest.centroid
    if not largest.contains(point):
        point = largest.representative_point()
    return [round(point.x, 4), round(point.y, 4)]


def build_geojson(year: int, precision: int) -> list[dict]:
    import geopandas as gpd

    zip_path = download(year)
    frame = gpd.read_file(f"zip://{zip_path.as_posix()}")
    texas = frame[frame.STATEFP == TEXAS_STATEFP].sort_values("NAME")
    if texas.empty:
        sys.exit("no Texas counties found in the source file")

    features = []
    vertices = 0
    for _, row in texas.iterrows():
        geom = row.geometry
        raw = json.loads(gpd.GeoSeries([geom]).to_json())["features"][0]["geometry"]
        if raw["type"] == "Polygon":
            coords = [thin(r, precision) for r in raw["coordinates"]]
            vertices += sum(len(r) for r in coords)
        else:
            coords = [[thin(r, precision) for r in poly] for poly in raw["coordinates"]]
            vertices += sum(len(r) for poly in coords for r in poly)
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "fips": row.GEOID,
                    "name": row.NAME,
                    "center": label_point(geom),
                },
                "geometry": {"type": raw["type"], "coordinates": coords},
            }
        )

    print(f"{len(features)} counties, {vertices} vertices")
    return features


def write_geojson(features: list[dict], year: int) -> None:
    DATA.mkdir(exist_ok=True)
    out = DATA / "tx-counties.geojson"
    payload = {
        "type": "FeatureCollection",
        "attribution": f"U.S. Census Bureau cartographic boundary files, {year} (public domain)",
        "features": features,
    }
    out.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1e6:.2f} MB)")


def write_csv(features: list[dict]) -> None:
    out = DATA / "counties.csv"
    existing: dict[str, str] = {}
    if out.exists():
        with out.open(newline="", encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                fips = (row.get("fips") or "").strip()
                if fips:
                    existing[fips] = row.get("description") or ""

    kept = 0
    with out.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["fips", "name", "description"])
        for f in features:
            fips = f["properties"]["fips"]
            description = existing.get(fips, "")
            if description:
                kept += 1
            writer.writerow([fips, f["properties"]["name"], description])

    note = f", kept {kept} existing description(s)" if existing else ""
    print(f"wrote {out.relative_to(ROOT)}{note}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, default=2024, help="Census vintage (default 2024)")
    ap.add_argument(
        "--precision",
        type=int,
        default=4,
        help="decimal places to keep on coordinates; 4 is ~11 m (default 4)",
    )
    args = ap.parse_args()

    features = build_geojson(args.year, args.precision)
    write_geojson(features, args.year)
    write_csv(features)


if __name__ == "__main__":
    main()
