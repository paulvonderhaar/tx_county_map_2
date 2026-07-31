/*
 * Texas county map.
 *
 * Renders data/tx-counties.geojson as one SVG path per county and joins
 * data/counties.csv (fips, name, description) onto it for the popups.
 * No build step, no dependencies.
 */

(function () {
  "use strict";

  var GEOJSON_URL = "data/tx-counties.geojson";
  var CSV_URL = "data/counties.csv";
  var DATACENTERS_URL = "data/datacenters.csv";

  var VIEW_WIDTH = 1000;   // SVG user units across the widest part of Texas
  var MAX_ZOOM = 40;       // how far in the viewBox may zoom
  var LABEL_PX = 11;       // on-screen label size, held constant through zoom
  var LABEL_FIT = 1.1;     // county must be this much wider than its own label
  var LABEL_MIN_ZOOM = 1.4; // below this the map stays unlabelled
  var DRAG_SLOP = 4;       // px of pointer travel before a click counts as a pan

  var els = {
    map: document.getElementById("map"),
    status: document.getElementById("status"),
    tooltip: document.getElementById("tooltip"),
    popup: document.getElementById("popup"),
    popupTitle: document.getElementById("popup-title"),
    popupMeta: document.getElementById("popup-meta"),
    popupBody: document.getElementById("popup-body"),
    popupClose: document.getElementById("popup-close"),
    search: document.getElementById("search"),
    results: document.getElementById("search-results"),
    live: document.getElementById("live"),
    zoomIn: document.getElementById("zoom-in"),
    zoomOut: document.getElementById("zoom-out"),
    reset: document.getElementById("reset"),
    legend: document.getElementById("legend"),
    coverage: document.getElementById("coverage"),
    layerButtons: document.querySelectorAll(".layer-btn")
  };

  var counties = [];                // { fips, name, path, cx, cy, width, description, node, labelNode }
  var byFips = Object.create(null);
  var svg, countyLayer, labelLayer;
  var home = { x: 0, y: 0, w: VIEW_WIDTH, h: VIEW_WIDTH };
  var view = null;                  // current viewBox
  var selected = null;              // fips whose popup is open
  var focused = null;               // fips under the keyboard cursor
  var activeLayer = "none";         // which shading layer is showing

  /* --------------------------------------------------------------- layers */

  // Each layer reads one aggregate off a county and sorts it into a bin.
  // Bins run highest first so the first match wins.
  var LAYERS = {
    projects: {
      label: "Projects",
      value: function (dc) { return dc.projects.length; },
      disclosed: function () { return true; }, // a project is its own evidence
      format: function (v) { return v === 1 ? "1 project" : v + " projects"; },
      bins: [
        { min: 4, label: "4 or more" },
        { min: 2, label: "2 to 3" },
        { min: 1, label: "1" }
      ],
      note: "Counts publicly reported projects, at any stage from proposed to operating."
    },
    power: {
      label: "Power",
      value: function (dc) { return dc.powerMw; },
      disclosed: function (dc) { return dc.powerDisclosed > 0; },
      format: formatMw,
      bins: [
        { min: 5000, label: "5,000 MW or more" },
        { min: 1000, label: "1,000 to 4,999 MW" },
        { min: 250, label: "250 to 999 MW" },
        { min: 1, label: "under 250 MW" }
      ],
      note: "Totals add each project's lowest published figure, so they are floors. Announced capacity is not built capacity."
    },
    water: {
      label: "Water",
      value: function (dc) { return dc.waterGpd; },
      disclosed: function (dc) { return dc.waterDisclosed > 0; },
      format: formatGpd,
      bins: [
        { min: 5000000, label: "5m gal/day or more" },
        { min: 1000000, label: "1m to 4.9m gal/day" },
        { min: 100000, label: "100k to 999k gal/day" },
        { min: 1, label: "under 100k gal/day" }
      ],
      note: "Water disclosure is voluntary in Texas and most operators publish nothing."
    }
  };

  function formatMw(mw) {
    return mw >= 1000 ? (mw / 1000).toLocaleString("en-US", {
      maximumFractionDigits: 1
    }) + " GW" : Math.round(mw).toLocaleString("en-US") + " MW";
  }

  function formatGpd(gpd) {
    if (gpd >= 1000000) {
      return (gpd / 1000000).toLocaleString("en-US", { maximumFractionDigits: 2 }) +
        "m gal/day";
    }
    return Math.round(gpd).toLocaleString("en-US") + " gal/day";
  }

  /* ------------------------------------------------------------------ CSV */

  // Minimal RFC 4180 parser: quoted fields, embedded commas and newlines,
  // "" as an escaped quote.
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = "";
    var quoted = false;
    var i = 0;

    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

    while (i < text.length) {
      var ch = text[i];

      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += ch; i++; continue;
      }

      if (ch === '"') { quoted = true; i++; continue; }
      if (ch === ",") { row.push(field); field = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }

      field += ch; i++;
    }

    row.push(field);
    rows.push(row);

    return rows.filter(function (r) {
      return r.length > 1 || r[0].trim() !== "";
    });
  }

  function csvToRecords(text) {
    var rows = parseCsv(text);
    if (rows.length < 2) return [];
    var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    return rows.slice(1).map(function (r) {
      var record = {};
      for (var i = 0; i < header.length; i++) record[header[i]] = (r[i] || "").trim();
      return record;
    });
  }

  /* --------------------------------------------------------- data centers */

  function toNumber(text) {
    var n = parseFloat(text);
    return isFinite(n) ? n : null;
  }

  // Attach data center projects to counties and roll up per-county totals.
  // Totals deliberately use each project's LOW figure: where a source gives a
  // range, or gives nothing, the county total must not overstate what has
  // actually been published.
  function attachDataCenters(records) {
    records.forEach(function (record) {
      var county = byFips[record.fips];
      if (!county) {
        if (record.fips) console.warn("datacenters.csv: unknown FIPS " + record.fips);
        return;
      }

      var powerLow = toNumber(record.power_mw_low);
      var powerHigh = toNumber(record.power_mw_high);
      var waterLow = toNumber(record.water_gpd_low);
      var waterHigh = toNumber(record.water_gpd_high);

      county.dc.projects.push({
        project: record.project,
        operator: record.operator,
        status: record.status,
        powerLow: powerLow,
        powerHigh: powerHigh,
        waterLow: waterLow,
        waterHigh: waterHigh,
        flags: record.flags ? record.flags.split(";").filter(Boolean) : [],
        notes: record.notes,
        sourceUrl: record.source_url,
        sourceTitle: record.source_title,
        asOf: record.as_of
      });

      var power = powerLow !== null ? powerLow : powerHigh;
      if (power !== null) {
        county.dc.powerMw += power;
        county.dc.powerDisclosed++;
      }

      var water = waterLow !== null ? waterLow : waterHigh;
      if (water !== null) {
        county.dc.waterGpd += water;
        county.dc.waterDisclosed++;
      }
    });
  }

  /* ----------------------------------------------------------- projection */

  // Albers equal-area conic using the parameters of EPSG:3083 (Texas Centric
  // Albers Equal Area), so the state sits square and undistorted.
  var DEG = Math.PI / 180;
  var PHI_1 = 27.5 * DEG, PHI_2 = 35 * DEG, PHI_0 = 18 * DEG, LAMBDA_0 = -100 * DEG;
  var CONE = (Math.sin(PHI_1) + Math.sin(PHI_2)) / 2;
  var CONST_C = Math.pow(Math.cos(PHI_1), 2) + 2 * CONE * Math.sin(PHI_1);
  var RHO_0 = Math.sqrt(CONST_C - 2 * CONE * Math.sin(PHI_0)) / CONE;

  function project(lon, lat) {
    var rho = Math.sqrt(CONST_C - 2 * CONE * Math.sin(lat * DEG)) / CONE;
    var theta = CONE * (lon * DEG - LAMBDA_0);
    return [rho * Math.sin(theta), RHO_0 - rho * Math.cos(theta)];
  }

  /* -------------------------------------------------------------- geometry */

  function eachRing(geometry, fn) {
    if (geometry.type === "Polygon") {
      geometry.coordinates.forEach(fn);
    } else if (geometry.type === "MultiPolygon") {
      geometry.coordinates.forEach(function (polygon) { polygon.forEach(fn); });
    }
  }

  function measure(features) {
    var box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    features.forEach(function (feature) {
      eachRing(feature.geometry, function (ring) {
        for (var i = 0; i < ring.length; i++) {
          var p = project(ring[i][0], ring[i][1]);
          if (p[0] < box.minX) box.minX = p[0];
          if (p[0] > box.maxX) box.maxX = p[0];
          if (p[1] < box.minY) box.minY = p[1];
          if (p[1] > box.maxY) box.maxY = p[1];
        }
      });
    });
    return box;
  }

  function buildCounties(features) {
    var box = measure(features);
    var scale = VIEW_WIDTH / (box.maxX - box.minX);

    // map space -> SVG space (y flips, because SVG y grows downward)
    function toSvg(lon, lat) {
      var p = project(lon, lat);
      return [(p[0] - box.minX) * scale, (box.maxY - p[1]) * scale];
    }

    home = { x: 0, y: 0, w: VIEW_WIDTH, h: (box.maxY - box.minY) * scale };

    return features.map(function (feature) {
      var props = feature.properties;
      var d = "";
      var minX = Infinity, maxX = -Infinity;

      eachRing(feature.geometry, function (ring) {
        for (var i = 0; i < ring.length; i++) {
          var p = toSvg(ring[i][0], ring[i][1]);
          if (p[0] < minX) minX = p[0];
          if (p[0] > maxX) maxX = p[0];
          d += (i === 0 ? "M" : "L") + p[0].toFixed(2) + " " + p[1].toFixed(2);
        }
        d += "Z";
      });

      var center = props.center ? toSvg(props.center[0], props.center[1]) : [0, 0];

      return {
        fips: props.fips,
        name: props.name,
        path: d,
        cx: center[0],
        cy: center[1],
        width: maxX - minX,
        // Rough rendered width of the label in px, for the does-it-fit test.
        labelWidth: props.name.length * LABEL_PX * 0.55,
        description: "",
        dc: { projects: [], powerMw: 0, waterGpd: 0, powerDisclosed: 0, waterDisclosed: 0 }
      };
    });
  }

  /* --------------------------------------------------------------- drawing */

  function svgEl(name, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  function render() {
    svg = svgEl("svg", {
      class: "map-svg",
      viewBox: "0 0 " + home.w + " " + home.h,
      preserveAspectRatio: "xMidYMid meet",
      tabindex: "0",
      role: "application",
      "aria-label":
        "Map of Texas counties. Use the arrow keys to move between counties and Enter to open details."
    });

    // Hatch marks the counties where projects are known but nobody has
    // published a figure for the active layer.
    var defs = svgEl("defs", {});
    var pattern = svgEl("pattern", {
      id: "hatch",
      width: "6",
      height: "6",
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)"
    });
    pattern.appendChild(svgEl("rect", { width: "6", height: "6", fill: "var(--county-fill)" }));
    pattern.appendChild(svgEl("rect", { width: "2.5", height: "6", fill: "var(--level-undisclosed)" }));
    defs.appendChild(pattern);
    svg.appendChild(defs);

    countyLayer = svgEl("g", { class: "county-layer" });
    labelLayer = svgEl("g", { class: "county-labels", "aria-hidden": "true" });

    counties.forEach(function (county) {
      var path = svgEl("path", { class: "county", d: county.path, "data-fips": county.fips });
      countyLayer.appendChild(path);
      county.node = path;

      var label = svgEl("text", { x: county.cx.toFixed(1), y: county.cy.toFixed(1) });
      label.textContent = county.name;
      label.classList.add("is-hidden");
      labelLayer.appendChild(label);
      county.labelNode = label;
    });

    svg.appendChild(countyLayer);
    svg.appendChild(labelLayer);
    els.status.remove();
    els.map.insertBefore(svg, els.map.firstChild);

    // Keep the map from running off a short window: cap its height, and cap
    // the container's width to match so no empty bands appear beside it.
    els.map.style.maxWidth = "calc(var(--map-max-height) * " + (home.w / home.h).toFixed(4) + ")";

    setView(home);
    attachMapEvents();
  }

  /* ------------------------------------------------------- layer painting */

  var LEVEL_CLASSES = ["level-1", "level-2", "level-3", "level-4", "level-undisclosed"];

  function levelFor(layer, county) {
    if (!county.dc.projects.length) return null;
    if (!layer.disclosed(county.dc)) return "level-undisclosed";
    var value = layer.value(county.dc);
    for (var i = 0; i < layer.bins.length; i++) {
      if (value >= layer.bins[i].min) return "level-" + (layer.bins.length - i);
    }
    return "level-undisclosed";
  }

  function setLayer(id) {
    activeLayer = id;
    var layer = LAYERS[id];

    counties.forEach(function (county) {
      county.node.classList.remove.apply(county.node.classList, LEVEL_CLASSES);
      if (!layer) return;
      var level = levelFor(layer, county);
      if (level) county.node.classList.add(level);
    });

    els.layerButtons.forEach(function (button) {
      var on = button.getAttribute("data-layer") === id;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });

    renderLegend(layer);
  }

  function legendItem(swatchStyle, text) {
    var item = document.createElement("span");
    item.className = "legend-item";
    var swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.cssText = swatchStyle;
    var label = document.createElement("span");
    label.textContent = text;
    item.appendChild(swatch);
    item.appendChild(label);
    return item;
  }

  function renderLegend(layer) {
    els.legend.textContent = "";
    if (!layer) {
      els.legend.hidden = true;
      return;
    }

    layer.bins.forEach(function (bin, index) {
      var level = layer.bins.length - index;
      els.legend.appendChild(
        legendItem("background: var(--level-" + level + ")", bin.label)
      );
    });

    els.legend.appendChild(legendItem(
      "background: repeating-linear-gradient(45deg, var(--level-undisclosed) 0 3px, var(--county-fill) 3px 7px)",
      "projects known, figure not published"
    ));
    els.legend.appendChild(legendItem(
      "background: var(--county-fill)", "no projects publicly reported"
    ));

    var note = document.createElement("span");
    note.className = "legend-note";
    note.textContent = layer.note;
    els.legend.appendChild(note);

    els.legend.hidden = false;
  }

  // A one-line statement of how much of the state this data actually covers.
  // It doubles as a load check: if the CSV goes missing in a deploy the map
  // still renders, so without this the only symptom would be an empty map.
  function renderCoverage() {
    var withProjects = counties.filter(function (c) { return c.dc.projects.length > 0; });
    var total = withProjects.reduce(function (n, c) { return n + c.dc.projects.length; }, 0);

    if (!total) {
      els.coverage.className = "coverage is-warning";
      els.coverage.textContent =
        "No data center projects loaded — data/datacenters.csv is missing or empty.";
      console.warn("datacenters.csv produced no usable rows");
      return;
    }

    els.coverage.className = "coverage";
    els.coverage.textContent =
      total + " data center projects publicly reported across " + withProjects.length +
      " of " + counties.length + " counties. The remaining " +
      (counties.length - withProjects.length) +
      " have none publicly reported, which is not the same as having none.";
  }

  /* ------------------------------------------------------------- view/zoom */

  function clampView(next) {
    var w = Math.min(home.w, Math.max(home.w / MAX_ZOOM, next.w));
    var h = w * (home.h / home.w);
    return {
      x: Math.min(home.w - w, Math.max(0, next.x)),
      y: Math.min(home.h - h, Math.max(0, next.y)),
      w: w,
      h: h
    };
  }

  function setView(next) {
    var previousWidth = view ? view.w : null;
    view = clampView(next);
    svg.setAttribute("viewBox", view.x + " " + view.y + " " + view.w + " " + view.h);
    // Labels only depend on the zoom level, so panning skips this entirely.
    if (view.w !== previousWidth) updateLabels();
    if (!els.popup.hidden && byFips[selected]) positionPopup(byFips[selected]);
  }

  // Size and stroke are set on the group, where they inherit, so one write
  // rescales all 254 labels. Sizes are converted from pixels through the
  // current scale, which keeps labels legible at every zoom level. The full
  // extent is left unlabelled — at that size only a handful of counties could
  // hold their own name, which reads as patchy rather than informative — and
  // names then appear as you zoom in and there is room for them.
  function updateLabels() {
    var scale = contentRect().scale;
    if (!scale || !isFinite(scale)) return;
    labelLayer.style.fontSize = (LABEL_PX / scale).toFixed(2) + "px";
    labelLayer.style.strokeWidth = (2.5 / scale).toFixed(2) + "px";

    var labelled = view.w < home.w / LABEL_MIN_ZOOM;
    counties.forEach(function (county) {
      var fits = labelled && county.width * scale > county.labelWidth * LABEL_FIT;
      county.labelNode.classList.toggle("is-hidden", !fits);
    });
  }

  // Zoom by `factor`, keeping the point at (ux, uy) in user space put.
  function zoomAt(factor, ux, uy) {
    var w = view.w / factor;
    var h = view.h / factor;
    setView({
      x: ux - (ux - view.x) * (w / view.w),
      y: uy - (uy - view.y) * (h / view.h),
      w: w,
      h: h
    });
  }

  function zoomCenter(factor) {
    zoomAt(factor, view.x + view.w / 2, view.y + view.h / 2);
  }

  // Frame a county with room to spare, without zooming past the limit.
  function zoomToCounty(county) {
    var w = Math.min(home.w, Math.max(home.w / MAX_ZOOM, county.width * 5));
    var h = w * (home.h / home.w);
    setView({ x: county.cx - w / 2, y: county.cy - h / 2, w: w, h: h });
  }

  /* --------------------------------------------------- coordinate helpers */

  // Where the viewBox content actually lands on screen. With
  // preserveAspectRatio="xMidYMid meet" the content is scaled to fit and
  // centred, so it only fills the whole <svg> box when the aspect ratios
  // happen to agree. Deriving the rect keeps hit-testing honest either way.
  function contentRect() {
    var rect = svg.getBoundingClientRect();
    var scale = Math.min(rect.width / view.w, rect.height / view.h);
    return {
      left: rect.left + (rect.width - view.w * scale) / 2,
      top: rect.top + (rect.height - view.h * scale) / 2,
      scale: scale
    };
  }

  // Client coordinates -> SVG user space.
  function toUserSpace(clientX, clientY) {
    var content = contentRect();
    return {
      x: view.x + (clientX - content.left) / content.scale,
      y: view.y + (clientY - content.top) / content.scale
    };
  }

  // SVG user space -> pixels relative to the map container.
  function toContainerPx(ux, uy) {
    var content = contentRect();
    var mapRect = els.map.getBoundingClientRect();
    return {
      x: (ux - view.x) * content.scale + (content.left - mapRect.left),
      y: (uy - view.y) * content.scale + (content.top - mapRect.top)
    };
  }

  function countyFromEvent(event) {
    var node = event.target.closest ? event.target.closest("path.county") : null;
    return node ? byFips[node.getAttribute("data-fips")] : null;
  }

  /* --------------------------------------------------------------- tooltip */

  function showTooltip(county, clientX, clientY) {
    var mapRect = els.map.getBoundingClientRect();
    els.tooltip.textContent = county.name;
    els.tooltip.classList.add("is-visible");
    els.tooltip.style.left =
      Math.min(clientX - mapRect.left + 12, mapRect.width - els.tooltip.offsetWidth - 6) + "px";
    els.tooltip.style.top =
      Math.min(clientY - mapRect.top + 14, mapRect.height - els.tooltip.offsetHeight - 6) + "px";
  }

  function hideTooltip() {
    els.tooltip.classList.remove("is-visible");
  }

  /* ----------------------------------------------------------------- popup */

  function openPopup(county) {
    if (selected && byFips[selected]) byFips[selected].node.classList.remove("is-selected");
    selected = county.fips;
    county.node.classList.add("is-selected");

    els.popupTitle.textContent = county.name + " County";
    els.popupMeta.textContent = "FIPS " + county.fips;
    els.popupBody.textContent = "";

    var paragraphs = county.description ? county.description.split(/\n\s*\n/) : [];
    var summary = summarise(county);

    // The generated summary leads, so a county with data centers never opens
    // on "No description yet" when there is plenty to say about it.
    if (summary) {
      var lede = document.createElement("p");
      lede.className = "dc-summary";
      lede.textContent = summary;
      els.popupBody.appendChild(lede);
    }

    if (!paragraphs.length) {
      if (!summary) {
        var empty = document.createElement("p");
        empty.className = "is-empty";
        empty.textContent = "No description yet.";
        els.popupBody.appendChild(empty);
      }
    } else {
      paragraphs.forEach(function (text) {
        var p = document.createElement("p");
        p.textContent = text.replace(/\s*\n\s*/g, " ").trim();
        els.popupBody.appendChild(p);
      });
    }

    renderProjects(county);

    els.popup.classList.toggle("has-projects", county.dc.projects.length > 0);
    els.popup.hidden = false;
    positionPopup(county);
    announce(
      county.name + " County. " +
      (summary || county.description || "No data center projects publicly reported.")
    );
  }

  // Render a value that a source may have given as a point, a range, or an
  // open-ended bound. Never invents a midpoint.
  function formatRange(low, high, format) {
    if (low === null && high === null) return null;
    if (low !== null && high !== null) {
      return low === high ? format(low) : format(low) + " to " + format(high);
    }
    return low !== null ? format(low) + " or more" : "up to " + format(high);
  }

  function figure(label, text) {
    var span = document.createElement("span");
    var strong = document.createElement("strong");
    strong.textContent = label + ": ";
    span.appendChild(strong);
    if (text) {
      span.appendChild(document.createTextNode(text));
    } else {
      var unknown = document.createElement("span");
      unknown.className = "is-unknown";
      unknown.textContent = "not published";
      span.appendChild(unknown);
    }
    return span;
  }

  /* --------------------------------------------------- prose summary */

  var NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six",
    "seven", "eight", "nine", "ten", "eleven", "twelve"];

  function count(n) {
    return n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : n.toLocaleString("en-US");
  }

  function gallonsProse(gpd) {
    if (gpd >= 1000000) {
      return (gpd / 1000000).toLocaleString("en-US", { maximumFractionDigits: 2 }) +
        " million gallons a day";
    }
    return Math.round(gpd).toLocaleString("en-US") + " gallons a day";
  }

  function joinList(items) {
    if (items.length === 1) return items[0];
    return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
  }

  function cap(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Written from the structured rows rather than stored as text, so the prose
  // cannot drift out of step with datacenters.csv. Phrasing stays neutral about
  // tense ("published figures") because a county can mix an operating site's
  // measured use with an announced site's projection.
  function summarise(county) {
    var dc = county.dc;
    var n = dc.projects.length;
    if (!n) return null;

    var sentences = [];
    var them = n === 1 ? "it" : "them";

    var statuses = {};
    dc.projects.forEach(function (p) { statuses[p.status] = (statuses[p.status] || 0) + 1; });
    var kinds = Object.keys(statuses);
    var lead = county.name + " County has " + count(n) + " publicly reported data center project" +
      (n === 1 ? "" : "s");

    if (n > 1 && kinds.length === 1) {
      sentences.push(lead + ", all " + kinds[0] + ".");
    } else {
      sentences.push(lead + ": " + joinList(kinds.map(function (s) {
        return n === 1 ? s : count(statuses[s]) + " " + s;
      })) + ".");
    }

    if (!dc.powerDisclosed) {
      sentences.push(n === 1
        ? "No power figure has been published."
        : "None of them has published a power figure.");
    } else if (dc.powerDisclosed === n) {
      // "comes to" rather than "published": a figure may be derived here rather
      // than reported, and the caveat sentence below says which.
      sentences.push(n === 1
        ? "Its power demand comes to " + formatMw(dc.powerMw) + "."
        : "Their power demand comes to " + formatMw(dc.powerMw) + ".");
    } else {
      sentences.push(
        cap(count(dc.powerDisclosed)) + " of the " + count(n) + " " +
        (dc.powerDisclosed === 1 ? "discloses" : "disclose") + " power demand, totalling " +
        formatMw(dc.powerMw) + "; " +
        (n - dc.powerDisclosed === 1 ? "the other has" : "the others have") +
        " published none."
      );
    }

    if (!dc.waterDisclosed) {
      sentences.push(n === 1
        ? "No water figure has been published either."
        : "No water figure has been published for any of " + them + ".");
    } else if (dc.waterDisclosed === n) {
      sentences.push(n === 1
        ? "Its water use comes to " + gallonsProse(dc.waterGpd) + "."
        : "Their water use comes to " + gallonsProse(dc.waterGpd) + ".");
    } else {
      sentences.push(
        cap(count(dc.waterDisclosed)) + " " +
        (dc.waterDisclosed === 1 ? "discloses" : "disclose") + " water use, totalling " +
        gallonsProse(dc.waterGpd) + "."
      );
    }

    var flags = {};
    dc.projects.forEach(function (p) {
      p.flags.forEach(function (f) { flags[f] = (flags[f] || 0) + 1; });
    });
    // Phrased without committing to a count: one row can carry several flags
    // at once, so "one figure is X and one is Y" would misdescribe Bexar, where
    // a single figure is both derived and combined.
    var caveats = [];
    if (flags.disputed) caveats.push("disputed by the developer");
    if (flags.derived) caveats.push("calculated here rather than reported");
    if (flags.combined) caveats.push("covering several projects at once");
    if (caveats.length) {
      sentences.push("Check the flags on the cards below: " + joinList(caveats) + ".");
    }

    if (dc.powerDisclosed < n || dc.waterDisclosed < n) {
      sentences.push(
        "Texas requires no public reporting of power or water use, so treat these as floors."
      );
    }

    return sentences.join(" ");
  }

  function renderProjects(county) {
    var dc = county.dc;
    if (!dc.projects.length) return;

    var section = document.createElement("div");
    section.className = "dc-section";

    var heading = document.createElement("h3");
    heading.className = "dc-heading";
    heading.textContent = "Data centers publicly reported";
    section.appendChild(heading);

    var totals = document.createElement("p");
    totals.className = "dc-totals";
    var count = document.createElement("strong");
    count.textContent = LAYERS.projects.format(dc.projects.length);
    totals.appendChild(count);
    if (dc.powerDisclosed) {
      totals.appendChild(document.createTextNode(
        " · " + formatMw(dc.powerMw) + " (" + dc.powerDisclosed + " of " +
        dc.projects.length + " disclose power)"
      ));
    }
    if (dc.waterDisclosed) {
      totals.appendChild(document.createTextNode(
        " · " + formatGpd(dc.waterGpd) + " (" + dc.waterDisclosed + " of " +
        dc.projects.length + " disclose water)"
      ));
    }
    section.appendChild(totals);

    dc.projects.forEach(function (p) {
      var card = document.createElement("div");
      card.className = "dc-project";

      var name = document.createElement("p");
      name.className = "dc-name";
      name.textContent = p.project;
      card.appendChild(name);

      var operator = document.createElement("p");
      operator.className = "dc-operator";
      operator.textContent = p.operator;
      operator.appendChild(document.createTextNode(" "));
      var status = document.createElement("span");
      status.className = "dc-badge status-" + p.status.replace(/\s+/g, "-");
      status.textContent = p.status;
      operator.appendChild(status);
      p.flags.forEach(function (flag) {
        var badge = document.createElement("span");
        badge.className = "dc-badge flag";
        badge.textContent = flag;
        operator.appendChild(document.createTextNode(" "));
        operator.appendChild(badge);
      });
      card.appendChild(operator);

      var figures = document.createElement("p");
      figures.className = "dc-figures";
      figures.appendChild(figure("Power", formatRange(p.powerLow, p.powerHigh, formatMw)));
      figures.appendChild(figure("Water", formatRange(p.waterLow, p.waterHigh, formatGpd)));
      card.appendChild(figures);

      if (p.notes) {
        var notes = document.createElement("p");
        notes.className = "dc-notes";
        notes.textContent = p.notes;
        card.appendChild(notes);
      }

      var source = document.createElement("p");
      source.className = "dc-source";
      var link = document.createElement("a");
      link.href = p.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = p.sourceTitle || "source";
      source.appendChild(document.createTextNode("Source: "));
      source.appendChild(link);
      if (p.asOf) source.appendChild(document.createTextNode(" (" + p.asOf + ")"));
      card.appendChild(source);

      section.appendChild(card);
    });

    els.popupBody.appendChild(section);
  }

  // Anchor the popup beside the county, nudged to stay inside the map. On
  // narrow screens the stylesheet turns it into a bottom sheet instead.
  function positionPopup(county) {
    if (window.matchMedia("(max-width: 640px)").matches) {
      els.popup.style.left = "";
      els.popup.style.top = "";
      return;
    }

    var point = toContainerPx(county.cx, county.cy);
    var mapRect = els.map.getBoundingClientRect();
    var box = els.popup.getBoundingClientRect();
    var margin = 10;

    var left = point.x + 16;
    if (left + box.width + margin > mapRect.width) left = point.x - box.width - 16;

    els.popup.style.left =
      Math.max(margin, Math.min(left, mapRect.width - box.width - margin)) + "px";
    els.popup.style.top =
      Math.max(margin, Math.min(point.y - box.height / 2, mapRect.height - box.height - margin)) + "px";
  }

  function closePopup() {
    els.popup.hidden = true;
    if (selected && byFips[selected]) byFips[selected].node.classList.remove("is-selected");
    selected = null;
  }

  function announce(message) {
    els.live.textContent = message;
  }

  /* ------------------------------------------------------------ map events */

  function attachMapEvents() {
    var pointers = new Map();
    var pinchDistance = 0;
    var panFrom = null;      // { pointer: {x,y} in user space }
    var pressedCounty = null;
    var travel = 0;

    function midpoint() {
      var pts = Array.from(pointers.values());
      return {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
        distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      };
    }

    svg.addEventListener("pointerdown", function (event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;

      // Resolve the county now: once the pointer is captured, later events in
      // this gesture retarget to the <svg> and lose the path.
      if (pointers.size === 0) {
        pressedCounty = countyFromEvent(event);
        travel = 0;
      }

      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      svg.setPointerCapture(event.pointerId);
      hideTooltip();

      if (pointers.size === 1) {
        panFrom = { pointer: toUserSpace(event.clientX, event.clientY) };
      } else if (pointers.size === 2) {
        panFrom = null;
        pinchDistance = midpoint().distance;
      }
    });

    svg.addEventListener("pointermove", function (event) {
      if (!pointers.has(event.pointerId)) {
        var hovered = countyFromEvent(event);
        if (hovered) showTooltip(hovered, event.clientX, event.clientY);
        else hideTooltip();
        return;
      }

      var previous = pointers.get(event.pointerId);
      travel += Math.abs(event.clientX - previous.x) + Math.abs(event.clientY - previous.y);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size >= 2) {
        var mid = midpoint();
        if (pinchDistance > 0 && mid.distance > 0) {
          var anchor = toUserSpace(mid.x, mid.y);
          zoomAt(mid.distance / pinchDistance, anchor.x, anchor.y);
        }
        pinchDistance = mid.distance;
        return;
      }

      if (panFrom && travel > DRAG_SLOP) {
        svg.classList.add("is-panning");
        var here = toUserSpace(event.clientX, event.clientY);
        setView({
          x: view.x + (panFrom.pointer.x - here.x),
          y: view.y + (panFrom.pointer.y - here.y),
          w: view.w,
          h: view.h
        });
        // Re-anchor to the same screen point now that the view has moved.
        panFrom.pointer = toUserSpace(event.clientX, event.clientY);
      }
    });

    function endPointer(event) {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      svg.classList.remove("is-panning");

      if (pointers.size < 2) pinchDistance = 0;

      if (pointers.size === 1) {
        var remaining = pointers.values().next().value;
        panFrom = { pointer: toUserSpace(remaining.x, remaining.y) };
        return;
      }

      if (pointers.size === 0) {
        panFrom = null;
        if (travel <= DRAG_SLOP) {
          if (pressedCounty) {
            setFocused(pressedCounty.fips);
            openPopup(pressedCounty);
          } else {
            closePopup();
          }
        }
        pressedCounty = null;
      }
    }

    svg.addEventListener("pointerup", endPointer);
    svg.addEventListener("pointercancel", endPointer);
    svg.addEventListener("pointerleave", hideTooltip);

    svg.addEventListener("wheel", function (event) {
      event.preventDefault();
      var anchor = toUserSpace(event.clientX, event.clientY);
      var factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0018));
      zoomAt(Math.max(0.2, Math.min(5, factor)), anchor.x, anchor.y);
    }, { passive: false });

    svg.addEventListener("dblclick", function (event) {
      var anchor = toUserSpace(event.clientX, event.clientY);
      zoomAt(1.8, anchor.x, anchor.y);
    });

    svg.addEventListener("keydown", onMapKeydown);
    svg.addEventListener("blur", function () { setFocused(null); });
  }

  /* ------------------------------------------------------------- keyboard */

  var ARROWS = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0]
  };

  function setFocused(fips) {
    if (focused && byFips[focused]) byFips[focused].node.classList.remove("is-focused");
    focused = fips;
    if (fips && byFips[fips]) byFips[fips].node.classList.add("is-focused");
  }

  // Nearest county in the arrow's direction: it has to lie within a 45-degree
  // cone that way, then the closest one wins.
  function neighbour(from, dx, dy) {
    var best = null;
    var bestScore = Infinity;
    counties.forEach(function (county) {
      if (county === from) return;
      var vx = county.cx - from.cx;
      var vy = county.cy - from.cy;
      var along = vx * dx + vy * dy;
      if (along <= 0) return;
      var across = Math.abs(vx * dy - vy * dx);
      if (across > along) return;
      var score = Math.hypot(vx, vy) + across * 0.5;
      if (score < bestScore) { bestScore = score; best = county; }
    });
    return best;
  }

  function centreCounty() {
    var cx = view.x + view.w / 2;
    var cy = view.y + view.h / 2;
    var best = null;
    var bestDistance = Infinity;
    counties.forEach(function (county) {
      var distance = Math.hypot(county.cx - cx, county.cy - cy);
      if (distance < bestDistance) { bestDistance = distance; best = county; }
    });
    return best;
  }

  function onMapKeydown(event) {
    if (event.key === "Escape") {
      closePopup();
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      if (focused && byFips[focused]) {
        event.preventDefault();
        openPopup(byFips[focused]);
      }
      return;
    }

    var direction = ARROWS[event.key];
    if (!direction) return;
    event.preventDefault();

    var current = focused ? byFips[focused] : null;
    var next = current ? neighbour(current, direction[0], direction[1]) : centreCounty();
    if (!next) return;

    setFocused(next.fips);
    if (els.popup.hidden) announce(next.name + " County");
    else openPopup(next);
  }

  /* --------------------------------------------------------------- search */

  var activeResult = -1;

  function searchCounties(query) {
    var needle = query.trim().toLowerCase();
    if (!needle) return [];
    var starts = [];
    var contains = [];
    counties.forEach(function (county) {
      var name = county.name.toLowerCase();
      if (name.indexOf(needle) === 0) starts.push(county);
      else if (name.indexOf(needle) > -1) contains.push(county);
    });
    return starts.concat(contains).slice(0, 8);
  }

  function closeResults() {
    els.results.hidden = true;
    els.search.setAttribute("aria-expanded", "false");
    els.search.removeAttribute("aria-activedescendant");
    activeResult = -1;
  }

  function renderResults(matches) {
    els.results.textContent = "";
    activeResult = -1;
    els.search.removeAttribute("aria-activedescendant");

    if (!els.search.value.trim()) {
      closeResults();
      return;
    }

    if (!matches.length) {
      var none = document.createElement("li");
      none.className = "search-empty";
      none.textContent = "No county matches that.";
      els.results.appendChild(none);
    } else {
      matches.forEach(function (county, index) {
        var item = document.createElement("li");
        item.textContent = county.name;
        item.id = "result-" + index;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", "false");
        item.setAttribute("data-fips", county.fips);
        els.results.appendChild(item);
      });
    }

    els.results.hidden = false;
    els.search.setAttribute("aria-expanded", "true");
  }

  function highlightResult(index) {
    var items = els.results.querySelectorAll("li[data-fips]");
    if (!items.length) return;
    activeResult = (index + items.length) % items.length;
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute("aria-selected", i === activeResult ? "true" : "false");
    }
    els.search.setAttribute("aria-activedescendant", "result-" + activeResult);
    items[activeResult].scrollIntoView({ block: "nearest" });
  }

  function chooseCounty(county) {
    closeResults();
    els.search.value = county.name;
    zoomToCounty(county);
    setFocused(county.fips);
    openPopup(county);
  }

  function attachSearchEvents() {
    els.search.addEventListener("input", function () {
      renderResults(searchCounties(els.search.value));
    });

    els.search.addEventListener("keydown", function (event) {
      var items = els.results.querySelectorAll("li[data-fips]");

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!items.length) return;
        event.preventDefault();
        highlightResult(activeResult + (event.key === "ArrowDown" ? 1 : -1));
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        var pick = items[activeResult > -1 ? activeResult : 0];
        if (pick) chooseCounty(byFips[pick.getAttribute("data-fips")]);
        return;
      }

      if (event.key === "Escape") closeResults();
    });

    els.results.addEventListener("click", function (event) {
      var item = event.target.closest("li[data-fips]");
      if (item) chooseCounty(byFips[item.getAttribute("data-fips")]);
    });

    document.addEventListener("pointerdown", function (event) {
      if (!els.search.parentNode.contains(event.target)) closeResults();
    });
  }

  function attachChromeEvents() {
    els.zoomIn.addEventListener("click", function () { zoomCenter(1.5); });
    els.zoomOut.addEventListener("click", function () { zoomCenter(1 / 1.5); });

    els.layerButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        setLayer(button.getAttribute("data-layer"));
      });
    });

    els.reset.addEventListener("click", function () {
      closePopup();
      setFocused(null);
      setView(home);
      els.search.value = "";
      closeResults();
    });

    els.popupClose.addEventListener("click", function () {
      closePopup();
      svg.focus();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !els.popup.hidden) closePopup();
    });

    // A resize changes the pixels-per-unit scale, so labels need remeasuring.
    window.addEventListener("resize", function () {
      updateLabels();
      if (!els.popup.hidden && byFips[selected]) positionPopup(byFips[selected]);
    });
  }

  /* ----------------------------------------------------------------- boot */

  function fail(html, detail) {
    if (detail) console.error(detail);
    if (!els.status.isConnected) els.map.appendChild(els.status);
    els.status.className = "status is-error";
    els.status.innerHTML = html;
  }

  function load() {
    Promise.all([
      fetch(GEOJSON_URL).then(function (response) {
        if (!response.ok) throw new Error(GEOJSON_URL + " returned HTTP " + response.status);
        return response.json();
      }),
      // The two CSVs are optional: a missing or broken one still leaves a
      // working map, it just has less in the popups.
      fetch(CSV_URL)
        .then(function (response) { return response.ok ? response.text() : ""; })
        .catch(function () { return ""; }),
      fetch(DATACENTERS_URL)
        .then(function (response) { return response.ok ? response.text() : ""; })
        .catch(function () { return ""; })
    ]).then(function (results) {
      counties = buildCounties(results[0].features);
      counties.forEach(function (county) { byFips[county.fips] = county; });

      csvToRecords(results[1]).forEach(function (record) {
        var county = byFips[record.fips];
        if (county) county.description = record.description || "";
        else if (record.fips) console.warn("counties.csv: unknown FIPS " + record.fips);
      });

      attachDataCenters(csvToRecords(results[2]));

      render();
      attachSearchEvents();
      attachChromeEvents();
      renderCoverage();
      // Open on the projects layer: with only a handful of counties carrying
      // data, an unshaded map reads as an empty one.
      setLayer("projects");
      els.search.placeholder = "Search " + counties.length + " counties…";
    }).catch(function (error) {
      if (location.protocol === "file:") {
        fail(
          "This page needs to be served over HTTP so it can load the map data.<br>" +
          "Run <code>python -m http.server 8000</code> in the project folder, " +
          "then open <code>http://localhost:8000</code>.",
          error
        );
      } else {
        fail("Could not load the map data. " + error.message, error);
      }
    });
  }

  load();
})();
