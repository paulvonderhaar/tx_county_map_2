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
data/tx-counties.geojson    county boundaries (generated, don't hand-edit)
scripts/build_data.py       regenerates the geojson from Census source data
_headers                    Cloudflare Pages response headers
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

## Preview locally

The page fetches its data files, which browsers block over `file://`, so serve
the folder rather than double-clicking `index.html`:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy to Cloudflare Pages

Push this folder to a GitHub repository, then in the Cloudflare dashboard:

1. **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, and pick
   the repository.
2. Configure the build:
   - Framework preset: **None**
   - Build command: **leave empty**
   - Build output directory: **`/`**
3. **Save and Deploy.**

There is nothing to compile, so the deploy is just a file upload. Every push to
the default branch publishes automatically — including CSV edits made straight
through the GitHub web editor, which is the quickest way to add descriptions
once the site is live.

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
