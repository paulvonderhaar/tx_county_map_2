#!/usr/bin/env python3
"""Build data/power_prices.csv: residential electricity price change by county.

Source: U.S. Energy Information Administration Form EIA-861, which is public
domain. Two files matter:

  Sales_Ult_Cust_YYYY.xlsx   revenue, sales and customers per utility per state
  Service_Territory_YYYY.xlsx  which counties each utility operates in

WHAT THIS NUMBER IS, AND IS NOT
-------------------------------
Texas has no county electricity price, because price is not set by county. In
the deregulated ERCOT area a household picks among many retail providers and
plans; elsewhere a co-op or municipal utility sets its own rate. EIA reports
revenue and sales per utility per STATE, never per county.

So this script computes, for each county:

    price = sum(residential revenue) / sum(residential sales)

over the utilities that operate in that county. Because each utility's revenue
and sales are statewide figures, the result is a sales-weighted average of the
rates charged by utilities operating in the county. It is a fair proxy for
"what utilities serving this county charge on average", and it is NOT the
average bill paid in that county. Two counties served by the same set of
utilities get the same number even if actual bills differ.

The change column compares two years on the same basis, which is more robust
than either year alone: a bias in how utilities are attributed to counties
largely cancels when taking a ratio.

Usage:
  python scripts/build_power_prices.py
  python scripts/build_power_prices.py --from 2019 --to 2024

Requires: pandas, openpyxl (pip install -r scripts/requirements.txt)
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = Path(__file__).resolve().parent / ".cache"

# The most recent year lives at a different path from the archived years.
CURRENT_URL = "https://www.eia.gov/electricity/data/eia861/zip/f861{year}.zip"
ARCHIVE_URL = "https://www.eia.gov/electricity/data/eia861/archive/zip/f861{year}.zip"


def fetch(year: int) -> Path:
    CACHE.mkdir(exist_ok=True)
    dest = CACHE / f"f861{year}.zip"
    if dest.exists():
        print(f"using cached {dest.name}")
        return dest
    for url in (CURRENT_URL.format(year=year), ARCHIVE_URL.format(year=year)):
        try:
            print(f"downloading {url}")
            with urllib.request.urlopen(url) as resp:
                body = resp.read()
            if body[:2] != b"PK":  # not a zip, we followed a redirect to HTML
                continue
            dest.write_bytes(body)
            print(f"  saved {len(body) / 1e6:.1f} MB")
            return dest
        except Exception as exc:  # noqa: BLE001 - try the next URL
            print(f"  failed: {exc}")
    sys.exit(f"could not download EIA-861 for {year}")


def read_sales(zf: zipfile.ZipFile, year: int):
    """Read the per-utility sales sheet without assuming a fixed column layout.

    The 2019 file carries an extra Short Form column that 2024 does not, so
    columns are located by their header text rather than by position.
    """
    import pandas as pd

    raw = pd.read_excel(
        zf.open(f"Sales_Ult_Cust_{year}.xlsx"), sheet_name="States", header=None
    )
    groups = raw.iloc[0].tolist()      # RESIDENTIAL / COMMERCIAL / ...
    fields = raw.iloc[2].tolist()      # Data Year / Utility Number / State / ...

    def find_field(name):
        for i, value in enumerate(fields):
            if str(value).strip().lower().startswith(name):
                return i
        sys.exit(f"column {name!r} not found in Sales_Ult_Cust_{year}")

    try:
        res = groups.index("RESIDENTIAL")
    except ValueError:
        sys.exit(f"RESIDENTIAL block not found in Sales_Ult_Cust_{year}")

    body = raw.iloc[3:].reset_index(drop=True)
    out = pd.DataFrame({
        "utility_id": body.iloc[:, find_field("utility number")],
        "utility": body.iloc[:, find_field("utility name")],
        "state": body.iloc[:, find_field("state")],
        "ownership": body.iloc[:, find_field("ownership")],
        "revenue": pd.to_numeric(body.iloc[:, res], errors="coerce"),
        "sales": pd.to_numeric(body.iloc[:, res + 1], errors="coerce"),
        "customers": pd.to_numeric(body.iloc[:, res + 2], errors="coerce"),
    })
    out = out[out.state.astype(str).str.strip().str.upper() == "TX"]
    return out[(out.revenue > 0) & (out.sales > 0)]


def read_territory(zf: zipfile.ZipFile, year: int):
    import pandas as pd

    terr = pd.read_excel(zf.open(f"Service_Territory_{year}.xlsx"), header=0)
    terr.columns = [str(c).strip().lower() for c in terr.columns]
    id_col = next(c for c in terr.columns if "utility number" in c)
    state_col = next(c for c in terr.columns if c == "state")
    county_col = next(c for c in terr.columns if "county" in c)
    terr = terr[terr[state_col].astype(str).str.strip().str.upper() == "TX"]
    return terr[[id_col, county_col]].rename(
        columns={id_col: "utility_id", county_col: "county"}
    )


def county_prices(year: int):
    """Sales-weighted average residential rate, in cents/kWh, per county."""
    import pandas as pd

    zf = zipfile.ZipFile(fetch(year))
    sales = read_sales(zf, year)
    terr = read_territory(zf, year)

    merged = terr.merge(sales, on="utility_id", how="inner")
    grouped = merged.groupby(merged.county.astype(str).str.strip()).agg(
        revenue=("revenue", "sum"),
        sales=("sales", "sum"),
        utilities=("utility_id", "nunique"),
    )
    # revenue is thousands of dollars and sales are MWh, so the ratio is
    # dollars per kWh; multiply by 100 for cents.
    grouped["cents_per_kwh"] = grouped.revenue / grouped.sales * 100
    print(f"{year}: {len(grouped)} counties, median "
          f"{grouped.cents_per_kwh.median():.2f} c/kWh")
    return grouped


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from", dest="start", type=int, default=2019)
    ap.add_argument("--to", dest="end", type=int, default=2024)
    args = ap.parse_args()

    early = county_prices(args.start)
    late = county_prices(args.end)

    geo = json.loads((DATA / "tx-counties.geojson").read_text(encoding="utf-8"))
    fips_by_name = {f["properties"]["name"]: f["properties"]["fips"]
                    for f in geo["features"]}

    rows = []
    unmatched = []
    for name, fips in sorted(fips_by_name.items()):
        if name not in early.index or name not in late.index:
            unmatched.append(name)
            continue
        a = early.loc[name]
        b = late.loc[name]
        rows.append({
            "fips": fips,
            "county": name,
            f"cents_per_kwh_{args.start}": round(a.cents_per_kwh, 2),
            f"cents_per_kwh_{args.end}": round(b.cents_per_kwh, 2),
            "percent_change": round(
                (b.cents_per_kwh - a.cents_per_kwh) / a.cents_per_kwh * 100, 1
            ),
            "utilities": int(b.utilities),
        })

    out = DATA / "power_prices.csv"
    with out.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()),
                                lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    print(f"\nwrote {out.relative_to(ROOT)}: {len(rows)} counties")
    if unmatched:
        print(f"no price for {len(unmatched)} counties: {', '.join(unmatched)}")
    changes = sorted(r["percent_change"] for r in rows)
    print(f"change range: {changes[0]:+.1f}% to {changes[-1]:+.1f}%, "
          f"median {changes[len(changes) // 2]:+.1f}%")


if __name__ == "__main__":
    main()
