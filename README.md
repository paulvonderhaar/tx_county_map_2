# Texas County Map

An interactive map of the 254 counties of Texas. Click a county and a small
popup shows its name and description. Descriptions live in a CSV you edit by
hand — no code changes needed to add text.

Static site: plain HTML, CSS, and JavaScript with no build step, no
dependencies, and no external requests. Deploys to Cloudflare Pages as-is.

## Layout

```
index.html                  the page
assets/styles.css           styling, light and dark
assets/app.js               map rendering and interaction
assets/favicon.svg
data/counties.csv           EDIT THIS — fips, name, description
data/datacenters.csv        EDIT THIS — one row per data center project
data/tx-counties.geojson    county boundaries (generated, don't hand-edit)
scripts/build_data.py       regenerates the geojson from Census source data
wrangler.jsonc              Cloudflare deploy config (required — see below)
.assetsignore               files kept out of the deployed site
_headers                    response headers (caching, content types)
```

## Writing the descriptions

`data/counties.csv` has one row per county and three columns:

| column | meaning |
| --- | --- |
| `fips` | 5-digit county FIPS code. This is the join key — don't change it. |
| `name` | County name, without the word "County". |
| `description` | The popup text. Leave empty and the popup says "No description yet." |

Only `description` is meant to be edited. A county with no description still
appears on the map and is still clickable.

Descriptions are rendered as plain text, so `<b>` and other markup will show up
literally rather than taking effect.

### Quoting rules

The file is standard CSV, which matters once your text contains punctuation:

- Text containing a comma, a quote, or a line break **must** be wrapped in
  double quotes.
- A literal double quote inside a quoted cell is written as two quotes: `""`.
- A blank line inside a quoted cell starts a new paragraph in the popup.

```csv
fips,name,description
48201,Harris,"County seat: Houston.

A blank line above starts a second paragraph."
48453,Travis,"County seat: Austin, which is also the state capital."
48003,Andrews,No punctuation here so no quotes needed.
```

Excel, LibreOffice, and Google Sheets all handle this quoting for you — open
the file, type in the `description` column, and save as CSV (UTF-8). In a
spreadsheet, <kbd>Alt</kbd>+<kbd>Enter</kbd> adds the line break within a cell.

Harris, Travis, El Paso, and Loving have sample descriptions filled in to show
the format. Clear them whenever you like.

## The data center layer

`data/datacenters.csv` holds one row per project. The map groups rows by county
and can shade counties by project count, power, or water.

### The sourcing rule

**Every figure must come from a published source, recorded in `source_url` on
the same row.** Nothing on this map is estimated, modelled, or inferred from
industry averages. This constraint is the point of the project, and it is worth
understanding why it is strict.

Texas keeps no public registry of data centers. The state does not require
operators to report power or water use, information given to ERCOT is not
public, and the state's own water survey drew responses from fewer than a third
of the companies it asked. So the honest map is a sparse one, and a county
shaded as having no known projects means **none have been publicly reported** —
not that none exist.

Because of that, three display states are deliberately kept distinct:

| State | Meaning |
| --- | --- |
| Shaded | Projects known and a figure published for the active layer |
| Hatched | Projects known, but nobody has published a figure for that layer |
| Plain | No projects publicly reported in that county |

Collapsing "hatched" into "plain" would turn a disclosure gap into an apparent
absence, which is the single easiest way for a map like this to mislead.

### Columns

| column | meaning |
| --- | --- |
| `fips` | County FIPS code. Join key to the boundaries. |
| `county`, `project`, `operator` | Names as published. |
| `status` | `operating`, `under construction`, `announced`, or `proposed`. |
| `power_mw_low`, `power_mw_high` | Leave both empty when undisclosed. Equal values for a point figure; both for a range; only `high` for "up to X"; only `low` for "X or more". |
| `water_gpd_low`, `water_gpd_high` | Same convention, gallons per day. |
| `flags` | Semicolon-separated: `disputed`, `derived`, `combined`, `undisclosed`. |
| `notes` | Caveats, acreage, anything qualifying the numbers. |
| `source_url`, `source_title`, `as_of` | Where the figure came from and when. |

County totals **add the low figure** from each project, so a total is a floor,
never a best guess. The popup shows how many of a county's projects actually
disclose each quantity — Hood County reads "3.1 GW (2 of 4 disclose power)"
rather than implying the total covers all four.

The `flags` matter as much as the numbers:

- `disputed` — the source figure is contested. Hood County's Comanche Circle is
  reported at 150,000 gal/day while the developer claims under 50,000 for three
  projects combined. Both claims belong in the row.
- `derived` — this project's figure was calculated here rather than reported.
  Bexar County's daily water number is 463 million gallons divided by 730 days.
  Anything derived must say so in `notes`.
- `combined` — the figure covers more than this one project, so it cannot be
  attributed to the site alone.

### Current coverage

Six counties: Bastrop, Bexar, Carson, Hood, Reeves, Taylor. This is a pilot, not
a census. Adding a county means finding a published source and adding rows.

## Preview locally

The page fetches its data files, which browsers block over `file://`, so serve
the folder rather than double-clicking `index.html`:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy to Cloudflare

This repository deploys as a **Worker serving static assets**, configured by
`wrangler.jsonc`. There is no Worker script and nothing to compile — the deploy
is a file upload.

`wrangler.jsonc` is what makes this work. Without it, Cloudflare's build runs
`npx wrangler versions upload` and fails with *"Missing entry-point to Worker
script or to assets directory"*, because wrangler has no way to know the
repository root is a website rather than an unconfigured Worker project.

**The `name` field must match your Worker.** Check it in the Cloudflare
dashboard under **Workers & Pages**; if the Worker is called something other
than `tx-county-map-2`, edit that one line or the build deploys to the wrong
place.

`.assetsignore` keeps non-website files (this README, `scripts/`, dotfiles) out
of the upload. `_headers` is deliberately *not* listed there: Workers reads it
to set response headers and never serves it as a file.

Once connected, every push publishes automatically — including CSV edits made
straight through the GitHub web editor, which is the quickest way to add
descriptions once the site is live. Pushes to the production branch deploy
live; other branches upload a preview version instead.

### If you would rather use Cloudflare Pages

Pages also works and ignores `wrangler.jsonc`. Create the project with
**Workers & Pages → Create → Pages → Connect to Git**, framework preset
**None**, build command **empty**, output directory **`/`**.

## Regenerating the boundaries

`data/tx-counties.geojson` is already committed, so you only need this if you
want a different Census vintage or coordinate precision.

```bash
pip install -r scripts/requirements.txt
python scripts/build_data.py
```

The script downloads the Census county file, keeps Texas, thins the
coordinates, and rewrites the geojson. It also rewrites `data/counties.csv`
while **preserving any descriptions already there**, adding rows for counties
it hasn't seen before.

## How the map is drawn

`app.js` reads the geojson and projects each county with an Albers equal-area
conic projection (the parameters of EPSG:3083, Texas Centric Albers), so the
state appears with the proportions you'd expect rather than stretched. Each
county becomes one SVG `<path>`; zooming and panning just move the SVG
`viewBox`, which is why the map stays sharp at any zoom.

Boundaries come from the U.S. Census Bureau
[cartographic boundary files](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html)
(2024, 1:500,000), which are in the public domain.
