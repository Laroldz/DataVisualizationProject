// Route explorer: geocode two addresses (Nominatim), get the driving route (OSRM), and show
// every geolocated FARS crash within a buffer of it. Uses helpers from main.js and county.js.

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const MAX_BUFFER = 200;           // metres; crashes are matched once at this distance, then filtered
const M_PER_DEG = 111320;         // metres per degree of latitude (and of longitude at the equator)
const M_PER_MILE = 1609.34;
const CELL = 0.01;                // grid cell size in degrees for the segment index

const route = { map: null, layers: null, result: null, bin: null, request: 0 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function routeStatus(text) { $("r-status").textContent = text; }

async function geocode(query) {
  const url = `${NOMINATIM}?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;
  const [hit] = await d3.json(url);
  if (!hit) throw new Error(`Couldn't find "${query}". Try adding a city and state.`);
  return { lat: +hit.lat, lon: +hit.lon, name: hit.display_name };
}

async function drive(a, b) {
  const res = await d3.json(`${OSRM}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`);
  if (res.code !== "Ok" || !res.routes.length) throw new Error("No driving route found between those places.");
  return res.routes[0].geometry.coordinates; // [lon, lat]
}

// ---------- geometry ----------

// Route segments in a local flat projection (each uses the cosine of its own latitude),
// with cumulative distance so a crash can be placed at a mile marker.
function buildSegments(coords) {
  const segs = [];
  let along = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon0, lat0] = coords[i - 1], [lon1, lat1] = coords[i];
    const k = Math.cos((lat0 + lat1) / 2 * Math.PI / 180);
    const dx = (lon1 - lon0) * k * M_PER_DEG, dy = (lat1 - lat0) * M_PER_DEG;
    const len = Math.hypot(dx, dy);
    segs.push({ lon0, lat0, lon1, lat1, k, dx, dy, len, along });
    along += len;
  }
  return { segs, length: along };
}

function segmentIndex(segs) {
  const grid = new Map();
  const pad = MAX_BUFFER / M_PER_DEG;
  segs.forEach((s, i) => {
    const padLon = pad / Math.max(s.k, 0.2);
    const x0 = Math.floor((Math.min(s.lon0, s.lon1) - padLon) / CELL), x1 = Math.floor((Math.max(s.lon0, s.lon1) + padLon) / CELL);
    const y0 = Math.floor((Math.min(s.lat0, s.lat1) - pad) / CELL), y1 = Math.floor((Math.max(s.lat0, s.lat1) + pad) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x},${y}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
  });
  return grid;
}

// Nearest point on the route: { dist (m), along (m from start) } or null if beyond MAX_BUFFER.
function nearestOnRoute(lon, lat, segs, grid) {
  const cand = grid.get(`${Math.floor(lon / CELL)},${Math.floor(lat / CELL)}`);
  if (!cand) return null;
  let best = null;
  for (const i of cand) {
    const s = segs[i];
    const px = (lon - s.lon0) * s.k * M_PER_DEG, py = (lat - s.lat0) * M_PER_DEG;
    const t = s.len ? Math.max(0, Math.min(1, (px * s.dx + py * s.dy) / (s.len * s.len))) : 0;
    const dist = Math.hypot(px - t * s.dx, py - t * s.dy);
    if (dist <= MAX_BUFFER && (!best || dist < best.dist)) best = { dist, along: s.along + t * s.len };
  }
  return best;
}

// Counties the route passes through (or comes within ~MAX_BUFFER of).
async function routeCounties(segs) {
  const shapes = (await countyShapes()).map(f => ({ f, b: d3.geoBounds(f) }));
  const found = new Set();
  let last = null;
  const off = MAX_BUFFER / M_PER_DEG;
  const lookup = (lon, lat) => {
    if (last && d3.geoContains(last.f, [lon, lat])) return found.add(+last.f.id);
    for (const s of shapes) {
      const [[w, so], [e, n]] = s.b;
      if (lon < w || lon > e || lat < so || lat > n) continue;
      if (d3.geoContains(s.f, [lon, lat])) { last = s; found.add(+s.f.id); return; }
    }
  };
  for (const s of segs) {
    const steps = Math.max(1, Math.ceil(s.len / 1000)); // sample at least every km
    for (let j = 0; j <= steps; j++) {
      const lon = s.lon0 + (s.lon1 - s.lon0) * j / steps, lat = s.lat0 + (s.lat1 - s.lat0) * j / steps;
      lookup(lon, lat);
      // Probe sideways too, so crashes just across a county line are not missed.
      lookup(lon + off / s.k, lat); lookup(lon - off / s.k, lat);
      lookup(lon, lat + off); lookup(lon, lat - off);
    }
  }
  return [...found];
}

// ---------- main flow ----------

async function findRoute() {
  const request = ++route.request;
  const from = $("r-from").value.trim(), to = $("r-to").value.trim();
  if (!from || !to) return routeStatus("Enter both a start and a destination.");
  $("r-go").disabled = true;
  try {
    routeStatus("Looking up addresses…");
    const a = await geocode(from);
    await sleep(1000); // Nominatim usage policy: at most 1 request per second
    const b = await geocode(to);

    routeStatus("Finding the driving route…");
    const coords = await drive(a, b);
    const { segs, length } = buildSegments(coords);

    routeStatus("Finding counties along the route…");
    const fips = await routeCounties(segs);

    routeStatus(`Loading crashes for ${fips.length} counties…`);
    const files = await Promise.all(fips.map(loadCountyCrashes));

    const grid = segmentIndex(segs);
    const matches = [];
    for (const file of files) {
      if (!file) continue;
      for (const c of file.crashes) {
        const hit = nearestOnRoute(c[1], c[0], segs, grid);
        if (hit) matches.push({ c, roads: file.roads, dist: hit.dist, mile: hit.along / M_PER_MILE });
      }
    }
    if (request !== route.request) return;

    route.result = { a, b, coords, miles: length / M_PER_MILE, matches, counties: fips.length };
    route.bin = null;
    $("r-results").hidden = false;
    if (!route.map) {
      route.map = createStreetMap("routemap", drawRoute);
      route.layers = L.layerGroup().addTo(route.map);
    }
    route.map.invalidateSize();
    route.map.fitBounds(L.latLngBounds(coords.map(([lon, lat]) => [lat, lon])), { padding: [24, 24] });
    refreshRoute();
  } catch (err) {
    if (request === route.request) routeStatus(`${err.message || err}`);
  } finally {
    $("r-go").disabled = false;
  }
}

function routeCrashes() {
  const y0 = Math.max(+ui.y0.value, POINT_FIRST_YEAR), y1 = +ui.y1.value, buffer = +$("r-buffer").value;
  return route.result.matches.filter(m => m.dist <= buffer && m.c[2] >= y0 && m.c[2] <= y1 && crashMatches(m.c));
}

// Called from main.js render() so the year range / measure controls apply here too.
function refreshRoute() {
  if (!route.result) return;
  const { miles, counties } = route.result;
  const crashes = routeCrashes();
  const deaths = d3.sum(crashes, m => m.c[5]);
  const y0 = Math.max(+ui.y0.value, POINT_FIRST_YEAR), y1 = +ui.y1.value;
  routeStatus(y1 < POINT_FIRST_YEAR
    ? `Crash locations are only recorded from ${POINT_FIRST_YEAR} on. Pick a later year range.`
    : `${fmtInt(crashes.length)} fatal crashes and ${fmtInt(deaths)} deaths within ${$("r-buffer").value} m of this ` +
      `${fmtRate(miles)}-mile route, ${y0}–${y1} (${fmtRate(deaths / miles * 10)} deaths per 10 miles; ${counties} counties).` +
      (filterActive() ? ` Filtered: ${filterSummary()}.` : ""));
  drawStrip(crashes);
  drawRoute();
}

// ---------- drawing ----------

function binsFor(crashes) {
  const miles = route.result.miles;
  const size = [0.5, 1, 2, 5, 10, 20, 25, 50, 100].find(s => miles / s <= 60) ?? 200;
  const bins = d3.range(0, miles, size).map(lo => ({ lo, hi: Math.min(lo + size, miles), crashes: [] }));
  for (const m of crashes) bins[Math.min(bins.length - 1, Math.floor(m.mile / size))].crashes.push(m);
  for (const b of bins) {
    b.deaths = d3.sum(b.crashes, m => m.c[5]);
    b.value = ui.measure.value === "fatals" ? b.deaths : b.crashes.length;
    const top = d3.greatest(d3.rollups(b.crashes, v => v.length, m => m.roads[m.c[6]]), d => d[1]);
    b.road = top?.[0] ?? "";
  }
  return { bins, size };
}

const S = { w: 640, h: 140, m: { t: 18, r: 8, b: 26, l: 32 } };

function drawStrip(crashes) {
  const { bins, size } = binsFor(crashes);
  const fmtMile = d3.format(size < 1 ? ",.1f" : ",.0f");
  const label = ui.measure.value === "fatals" ? "deaths" : "fatal crashes";
  const x = d3.scaleLinear([0, route.result.miles], [S.m.l, S.w - S.m.r]);
  const y = d3.scaleLinear([0, d3.max(bins, b => b.value) || 1], [S.h - S.m.b, S.m.t]).nice();
  const hl = darkQuery.matches ? HIGHLIGHT.dark : HIGHLIGHT.light;

  const svg = d3.select("#strip").html("");
  svg.append("g").attr("class", "grid").attr("transform", `translate(${S.m.l},0)`)
    .call(d3.axisLeft(y).ticks(3).tickSize(-(S.w - S.m.l - S.m.r)).tickFormat(d3.format("d")))
    .call(g => g.select(".domain").remove())
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--grid)"));
  svg.append("g").attr("transform", `translate(0,${S.h - S.m.b})`)
    .call(d3.axisBottom(x).ticks(8).tickSizeOuter(0))
    .call(g => g.select(".domain").attr("stroke", "var(--axis)"))
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--axis)"));
  svg.append("text").attr("x", S.m.l).attr("y", 10).text(`${label} per ${size}-mile stretch, by miles from start`);

  const barW = Math.max(1, x(size) - x(0) - 2); // 2px surface gap between bars
  svg.append("g").selectAll("rect").data(bins).join("rect")
    .attr("class", "bar")
    .attr("x", b => x(b.lo) + 1).attr("width", barW)
    .attr("y", b => y(b.value)).attr("height", b => y(0) - y(b.value))
    .attr("rx", Math.min(2, barW / 2))
    .attr("fill", b => route.bin === b.lo ? hl : "var(--series-1)");
  // Full-height hit targets, larger than the bars.
  svg.append("g").selectAll("rect").data(bins).join("rect")
    .attr("x", b => x(b.lo)).attr("width", x(size) - x(0))
    .attr("y", S.m.t).attr("height", S.h - S.m.t - S.m.b).attr("fill", "transparent").style("cursor", "pointer")
    .on("mousemove", (e, b) => tipAt(e, `<b>Miles ${fmtMile(b.lo)}–${fmtMile(b.hi)}</b>` +
      `<div class="row"><span>Fatal crashes</span>${b.crashes.length}</div>` +
      `<div class="row"><span>Deaths</span>${b.deaths}</div>` +
      (b.road ? `<div class="row"><span>Main road</span>${b.road}</div>` : "")))
    .on("mouseleave", hideTip)
    .on("click", (e, b) => focusStretch(route.bin === b.lo ? null : b));

  const top = bins.filter(b => b.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);
  $("stretch-col").textContent = ui.measure.value === "fatals" ? "Deaths" : "Crashes";
  d3.select("#stretches tbody").selectAll("tr").data(top, b => b.lo).join("tr")
    .classed("active", b => route.bin === b.lo)
    .on("click", (e, b) => focusStretch(route.bin === b.lo ? null : b))
    .html(b => `<td>${fmtMile(b.lo)}–${fmtMile(b.hi)}</td><td>${b.road}</td><td class="num">${fmtInt(b.value)}</td>`);
  $("stretches-empty").hidden = top.length > 0;
}

function focusStretch(bin) {
  route.bin = bin?.lo ?? null;
  refreshRoute();
  const { coords, miles } = route.result;
  if (!bin) return route.map.fitBounds(L.latLngBounds(coords.map(([lon, lat]) => [lat, lon])), { padding: [24, 24] });
  // Route vertices whose position falls inside the stretch.
  const { segs } = buildSegments(coords);
  const pts = segs.filter(s => s.along / M_PER_MILE >= bin.lo && s.along / M_PER_MILE <= bin.hi).map(s => [s.lat0, s.lon0]);
  if (pts.length) route.map.fitBounds(L.latLngBounds(pts), { padding: [32, 32], maxZoom: 15 });
}

function drawRoute() {
  if (!route.result) return;
  const { a, b, coords } = route.result;
  const hl = darkQuery.matches ? HIGHLIGHT.dark : HIGHLIGHT.light;
  const binSize = route.bin === null ? null : binsFor([]).size;
  const inBin = m => route.bin !== null && m.mile >= route.bin && m.mile < route.bin + binSize;

  route.layers.clearLayers();
  L.polyline(coords.map(([lon, lat]) => [lat, lon]), { color: cssVar("--ink-2"), weight: 4, opacity: 0.55, interactive: false })
    .addTo(route.layers);
  const crashes = routeCrashes();
  for (const m of [...crashes.filter(m => !inBin(m)), ...crashes.filter(inBin)]) {
    crashMarker(m.c, {
      ...(inBin(m) && { fillColor: hl }),
      fillOpacity: route.bin === null || inBin(m) ? 0.85 : 0.25,
    })
      .bindTooltip(crashTip(m.c, m.roads, `<div class="row"><span>Mile</span>${fmtRate(m.mile)}</div>`),
        { direction: "top", offset: [0, -4], className: "crash-tip" })
      .addTo(route.layers);
  }
  for (const [p, label] of [[a, "Start"], [b, "End"]]) {
    L.circleMarker([p.lat, p.lon], { radius: 7, color: cssVar("--surface"), weight: 2, fillColor: cssVar("--ink"), fillOpacity: 1 })
      .bindTooltip(`<b>${label}</b>${p.name}`, { direction: "top", offset: [0, -6], className: "crash-tip" })
      .addTo(route.layers);
  }
}

$("route-form").addEventListener("submit", e => { e.preventDefault(); findRoute(); });
$("r-buffer").addEventListener("change", refreshRoute);
$("to-route").addEventListener("click", () => $("route").scrollIntoView({ behavior: "smooth", block: "start" }));
