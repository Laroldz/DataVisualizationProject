// Route explorer: geocode two addresses (Nominatim), get the driving route (OSRM), and show
// every geolocated FARS crash within a buffer of it. Uses helpers from main.js and county.js.

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const MAX_BUFFER = 200;           // metres; crashes are matched once at this distance, then filtered
const M_PER_DEG = 111320;         // metres per degree of latitude (and of longitude at the equator)
const M_PER_MILE = 1609.34;
const CELL = 0.01;                // grid cell size in degrees for the segment index

const route = { map: null, layers: null, result: null, alts: [], bin: null, request: 0, showAll: false, view: { heat: false, groups: new Set(), allFactors: false } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function routeStatus(text) { $("r-status").textContent = text; }

async function geocode(query) {
  const url = `${NOMINATIM}?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;
  const [hit] = await d3.json(url);
  if (!hit) throw new Error(`Couldn't find "${query}". Try adding a city and state.`);
  return { lat: +hit.lat, lon: +hit.lon, name: hit.display_name };
}

// The fastest route plus up to two alternatives: [{ coords: [[lon, lat], ...], minutes }].
async function drive(a, b) {
  const res = await d3.json(`${OSRM}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&alternatives=true`);
  if (res.code !== "Ok" || !res.routes.length) throw new Error("No driving route found between those places.");
  return res.routes.slice(0, 3).map(r => ({ coords: r.geometry.coordinates, minutes: r.duration / 60 }));
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

    routeStatus("Finding driving routes…");
    const options = await drive(a, b);

    routeStatus(`Finding counties along ${options.length > 1 ? `the ${options.length} routes` : "the route"}…`);
    const alts = [];
    for (const [k, opt] of options.entries()) {
      const { segs, length } = buildSegments(opt.coords);
      const fips = await routeCounties(segs);
      routeStatus(`Loading crashes for route ${k + 1} of ${options.length} (${fips.length} counties)…`);
      const files = (await Promise.all(fips.map(loadCountyCrashes))).filter(Boolean);
      const grid = segmentIndex(segs);
      const matches = [];
      for (const file of files) {
        for (const c of file.crashes) {
          const hit = nearestOnRoute(c[1], c[0], segs, grid);
          if (hit) matches.push({ c, roads: file.roads, dist: hit.dist, mile: hit.along / M_PER_MILE });
        }
      }
      alts.push({ a, b, coords: opt.coords, minutes: opt.minutes, miles: length / M_PER_MILE, matches, counties: fips.length, files,
                  name: String.fromCharCode(65 + k) });
    }
    if (request !== route.request) return;

    route.alts = alts;
    route.result = alts[0];
    route.bin = null;
    const coords = alts.flatMap(r => r.coords);
    $("r-results").hidden = false;
    if (!route.map) {
      route.map = createStreetMap("routemap", drawRoute);
      route.layers = L.layerGroup().addTo(route.map);
      addHeatToggle(route.map, route.view, drawRoute);
      addStopsToggle(route.map);
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

function routeCrashes(result = route.result) {
  const y0 = Math.max(+ui.y0.value, POINT_FIRST_YEAR), y1 = +ui.y1.value, buffer = +$("r-buffer").value;
  return result.matches.filter(m => m.dist <= buffer && m.c[2] >= y0 && m.c[2] <= y1 && crashMatches(m.c));
}

// "Compare routes" table, shown when the routing service offers alternatives.
function drawAlts() {
  $("alt-card").hidden = route.alts.length < 2;
  if (route.alts.length < 2) return;
  const rows = route.alts.map(r => {
    const crashes = routeCrashes(r), deaths = d3.sum(crashes, m => m.c[5]);
    return { r, crashes: crashes.length, deaths, per10: deaths / r.miles * 10 };
  });
  const best = d3.least(rows, d => d.per10);
  const mins = m => m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`;
  d3.select("#alts tbody").selectAll("tr").data(rows).join("tr")
    .classed("active", d => d.r === route.result)
    .on("click", (e, d) => selectAlt(d.r))
    .html(d => `<td><b>Route ${d.r.name}</b>${d.r === route.alts[0] ? " <span class=\"muted\">(fastest)</span>" : ""}` +
      `${d === best ? ` <span class="tag-best">fewest deaths per mile</span>` : ""}</td>` +
      `<td class="num">${fmtRate(d.r.miles)}</td><td class="num">${mins(d.r.minutes)}</td>` +
      `<td class="num">${fmtInt(d.crashes)}</td><td class="num">${fmtInt(d.deaths)}</td><td class="num">${fmtRate(d.per10)}</td>`);
}

function selectAlt(r) {
  route.result = r;
  route.bin = null;
  route.map.fitBounds(L.latLngBounds(r.coords.map(([lon, lat]) => [lat, lon])), { padding: [24, 24] });
  refreshRoute();
}

// Called from main.js render() so the year range / measure controls apply here too.
function refreshRoute() {
  if (!route.result) return;
  const crashes = routeCrashes();
  const deaths = d3.sum(crashes, m => m.c[5]);
  const y0 = Math.max(+ui.y0.value, POINT_FIRST_YEAR), y1 = +ui.y1.value;
  // The "Your drive" card carries the totals, so the status line only speaks up when there's nothing to show.
  routeStatus(y1 < POINT_FIRST_YEAR ? `Crash locations are only recorded from ${POINT_FIRST_YEAR} on. Pick a later year range.` : "");
  drawAlts();
  drawDriveCard(crashes, deaths, y0, y1);
  drawTrip(crashes);
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
  const binSize = route.bin === null ? null : binsFor([]).size;
  const inBin = m => route.bin !== null && m.mile >= route.bin && m.mile < route.bin + binSize;

  route.layers.clearLayers();
  const many = route.alts.length > 1;
  for (const alt of route.alts) {
    if (alt === route.result) continue;
    L.polyline(alt.coords.map(([lon, lat]) => [lat, lon]),
      { color: cssVar(route.showAll ? "--ink-2" : "--muted"), weight: 3, opacity: route.showAll ? 0.55 : 0.45, dashArray: "6 6" })
      .bindTooltip(`Route ${alt.name}: click to see its details`, { sticky: true, className: "crash-tip" })
      .on("click", () => selectAlt(alt))
      .addTo(route.layers);
  }
  L.polyline(coords.map(([lon, lat]) => [lat, lon]), { color: cssVar("--ink-2"), weight: 4, opacity: 0.55, interactive: false })
    .addTo(route.layers);
  if (many) for (const alt of route.alts) routeBadge(alt).addTo(route.layers);

  // One entry per crash. With "show all routes", a crash near several routes is drawn once and
  // its tooltip lists each route and mile.
  const crashes = route.showAll && many ? allRouteCrashes() : routeCrashes();
  // A selected stretch wins; otherwise the chosen trip time is highlighted.
  const slot = tripSlot();
  const focus = route.bin !== null ? inBin : slot ? m => inSlot(m.c, slot) : null;
  updateTypeLegend(route.view, (focus ? crashes.filter(focus) : crashes).map(m => m.c), drawRoute);
  const on = m => (!focus || focus(m)) && kindOn(route.view, m.c);
  if (route.view.heat) heatLayer(crashes.filter(on).map(m => m.c)).addTo(route.layers);
  else for (const m of [...crashes.filter(m => !on(m)), ...crashes.filter(on)]) {
    const where = m.on
      ? m.on.map(x => `<div class="row"><span>Route ${x.alt.name}</span>mile ${fmtRate(x.mile)}</div>`).join("")
      : `<div class="row"><span>Mile</span>${fmtRate(m.mile)}</div>`;
    crashMarker(m.c, dotStyle(on(m), !!focus && on(m)))
      .bindTooltip(crashTip(m.c, m.roads, where), { direction: "top", offset: [0, -4], className: "crash-tip" })
      .addTo(route.layers);
  }
  for (const [p, label] of [[a, "Start"], [b, "End"]]) {
    L.circleMarker([p.lat, p.lon], { radius: 7, color: cssVar("--surface"), weight: 2, fillColor: cssVar("--ink"), fillOpacity: 1 })
      .bindTooltip(`<b>${label}</b>${p.name}`, { direction: "top", offset: [0, -6], className: "crash-tip" })
      .addTo(route.layers);
  }
  drawStops();
}

// Every alternative's crashes, each crash once, tagged with the routes (and miles) it lies on.
// The selected route's mile is kept as `mile`, so stretch highlighting still works for it.
function allRouteCrashes() {
  const byCrash = new Map();
  for (const alt of route.alts) {
    for (const m of routeCrashes(alt)) {
      if (!byCrash.has(m.c)) byCrash.set(m.c, { c: m.c, roads: m.roads, mile: alt === route.result ? m.mile : -1, on: [] });
      const entry = byCrash.get(m.c);
      entry.on.push({ alt, mile: m.mile });
      if (alt === route.result) entry.mile = m.mile;
    }
  }
  return [...byCrash.values()];
}

// Letter badge ("A", "B"...) placed partway along a route, so overlapping lines can be told apart.
function routeBadge(alt) {
  const k = route.alts.indexOf(alt);
  const [lon, lat] = alt.coords[Math.floor(alt.coords.length * (0.35 + 0.15 * k))];
  const sel = alt === route.result;
  return L.marker([lat, lon], {
    icon: L.divIcon({ className: `route-badge${sel ? " sel" : ""}`, html: alt.name, iconSize: [22, 22] }),
    title: `Route ${alt.name}`,
  }).on("click", () => selectAlt(alt));
}

$("alt-all").addEventListener("change", e => {
  route.showAll = e.target.checked;
  const lines = (route.showAll ? route.alts : [route.result]).flatMap(r => r.coords);
  route.map.fitBounds(L.latLngBounds(lines.map(([lon, lat]) => [lat, lon])), { padding: [24, 24] });
  drawRoute();
});

$("route-form").addEventListener("submit", e => { e.preventDefault(); findRoute(); });
$("r-buffer").addEventListener("change", refreshRoute);
$("r-time").innerHTML = `<option value="any">Any time</option>` + d3.range(0, 24, 2)
  .map(h => `<option value="${h}">${hourLabel(h)}–${hourLabel(h + 2)}</option>`).join("");
for (const id of ["r-day", "r-time", "r-season"]) $(id).addEventListener("change", refreshRoute);

// ---------- trip time ----------

const DAY_ROWS = [2, 3, 4, 5, 6, 7, 1];        // FARS day of week: 1 = Sunday ... 7 = Saturday
const DAY_SHORT = { 1: "Sun", 2: "Mon", 3: "Tue", 4: "Wed", 5: "Thu", 6: "Fri", 7: "Sat" };
const DAY_SETS = { weekday: [2, 3, 4, 5, 6], weekend: [1, 7] };
const SEASONS = { winter: [12, 1, 2], spring: [3, 4, 5], summer: [6, 7, 8], fall: [9, 10, 11] };

function hourLabel(h) {
  h %= 24;
  return h === 0 ? "12 AM" : h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`;
}

// { days, start, end, label } for "When do you usually drive?", or null for any day and time.
function tripSlot() {
  const day = $("r-day").value, time = $("r-time").value, season = $("r-season").value;
  if (day === "any" && time === "any" && season === "any") return null;
  const days = day === "any" ? [1, 2, 3, 4, 5, 6, 7] : DAY_SETS[day] ?? [+day];
  const start = time === "any" ? 0 : +time, end = time === "any" ? 24 : start + 2;
  const months = SEASONS[season] ?? null;
  const parts = [day === "any" ? "" : $("r-day").selectedOptions[0].text, time === "any" ? "" : $("r-time").selectedOptions[0].text,
                 months ? `in ${season}` : ""].filter(Boolean);
  const label = parts.join(", ");
  return { days, start, end, months, label: label[0].toUpperCase() + label.slice(1), anyTime: day === "any" && time === "any" };
}

// Row layout: [lat, lon, year, month, hour, fatals, road, cats, flags, dow, day]
function inSlot(c, slot) {
  return slot.days.includes(c[9]) && c[4] >= slot.start && c[4] < slot.end && (!slot.months || slot.months.includes(c[3]));
}

function drawTrip(crashes) {
  const slot = tripSlot();
  const known = crashes.filter(m => m.c[4] < 24 && m.c[9] >= 1 && m.c[9] <= 7);
  if (!slot) {
    $("trip-text").innerHTML = "Pick when you usually drive (above) to see how that time compares. " +
      "The chart shows when this route's crashes happened: darker squares had more.";
  } else {
    const n = known.filter(m => inSlot(m.c, slot)).length;
    // The window's share of the year, e.g. weekdays 5-7 PM = 5 days x 2 hours / 168 hours; a season is ~3 of 12 months.
    const expected = slot.days.length * (slot.end - slot.start) / (7 * 24) * (slot.months ? slot.months.length / 12 : 1);
    const ratio = known.length ? n / known.length / expected : 0;
    const times = d3.format(".1f")(ratio);
    const verdict = !known.length ? ""
      : ratio >= 1.15 ? `That's <b>${times}×</b> the average for a time window this long, so take extra care.`
      : ratio <= 0.87 ? `That's <b>${times}×</b> the average for a time window this long: quieter than most times.`
      : "That's about average for a time window this long.";
    $("trip-text").innerHTML = `<b>${slot.label}:</b> ${fmtInt(n)} of ${fmtInt(known.length)} crashes on this route ` +
      `(${d3.format(".0%")(known.length ? n / known.length : 0)}). ${verdict}` +
      (n < 5 ? ` <span class="muted">Few crashes at this time, so treat this as a rough guide.</span>` : "") +
      (slot.anyTime ? " They're highlighted on the map, and the chart shows only that season." : " They're highlighted on the map and outlined in the chart.");
  }
  // With a season chosen, the chart shows only that season's crashes.
  drawTripHeat(slot?.months ? known.filter(m => slot.months.includes(m.c[3])) : known, slot);
}

function drawTripHeat(known, slot) {
  const cw = 13, ch = 13, left = 34, top = 16;
  const grid = DAY_ROWS.map(d => d3.range(24).map(h => known.filter(m => m.c[9] === d && m.c[4] === h).length));
  const max = d3.max(grid.flat()) || 1;
  const color = d3.scaleQuantize([0, max], RAMP_LIGHT);
  const svg = d3.select("#trip-heat").attr("viewBox", `0 0 ${left + 24 * cw + 2} ${top + 7 * ch + 4}`).html("");
  [0, 6, 12, 18].forEach(h => svg.append("text").attr("class", "axis-lab").attr("x", left + h * cw).attr("y", 10).text(hourLabel(h)));
  DAY_ROWS.forEach((d, r) => {
    svg.append("text").attr("class", "axis-lab").attr("x", 0).attr("y", top + r * ch + 10).text(DAY_SHORT[d]);
    grid[r].forEach((v, h) => svg.append("rect")
      .attr("x", left + h * cw).attr("y", top + r * ch).attr("width", cw - 1).attr("height", ch - 1).attr("rx", 2)
      .attr("fill", v ? color(v) : "var(--grid)")
      .on("mousemove", e => tipAt(e, `<b>${DAY_SHORT[d]} ${hourLabel(h)}–${hourLabel(h + 1)}</b>` +
        `<div class="row"><span>Fatal crashes</span>${v}</div>`))
      .on("mouseleave", hideTip));
  });
  if (!slot || slot.anyTime) return;
  // Outline the chosen time window on each chosen day.
  DAY_ROWS.forEach((d, r) => {
    if (!slot.days.includes(d)) return;
    svg.append("rect").attr("class", "slot")
      .attr("x", left + slot.start * cw - 1.5).attr("y", top + r * ch - 1.5)
      .attr("width", (slot.end - slot.start) * cw + 2).attr("height", ch + 2).attr("rx", 3);
  });
}

// ---------- "Your drive" summary ----------

const ROUTE_FACTORS = [
  { label: "After dark", phrase: "after dark", cat: ["light", ["Dark"]],
    tip: "Many happened after dark: slow down where roads are poorly lit, and watch for impaired drivers late at night." },
  { label: "Distracted driver", phrase: "involved a distracted driver", flag: "distracted",
    tip: "Distraction stands out: put the phone away (or on Do Not Disturb) and set navigation before you go." },
  { label: "Drowsy driver", phrase: "involved a drowsy driver", flag: "drowsy",
    tip: "Drowsy driving shows up here: take a break at one of the places listed in this card, and don't drive when you're tired." },
  { label: "Drinking driver", phrase: "involved a drinking driver", flag: "alcohol",
    tip: "Many involved a drinking driver: plan a sober ride, and give erratic drivers plenty of room." },
  { label: "Speeding", phrase: "involved speeding", flag: "speeding",
    tip: "Speed was a factor in many: keep to the limit, especially on curves and near work zones." },
  { label: "Lane changes & merging", phrase: "were lane-change or merge crashes", cat: ["crash_type", ["Sideswipe, same direction"]],
    tip: "Lane changes and merges stand out: check mirrors and blind spots, and signal early." },
  { label: "Rain", phrase: "were in rain", cat: ["weather", ["Rain"]],
    tip: "Wet roads stand out: slow down and leave extra following distance in rain." },
  { label: "Large truck", phrase: "involved a large truck", flag: "large_truck",
    tip: "Large trucks stand out: stay out of their blind spots and give them room to stop." },
  { label: "Pedestrian", phrase: "involved a pedestrian", flag: "pedestrian",
    tip: "Pedestrians stand out: watch for people walking, especially near intersections and at night." },
];

// [is the factor recorded for this crash, does it apply]
function factorOf(f, c) {
  if (f.flag) { const v = flagValue(c[8], f.flag); return [v > 0, v === 2]; }
  const v = catValue(c[7], f.cat[0]);
  const label = filters.meta.categories[f.cat[0]][v - 1] ?? "";
  return [v > 0, v > 0 && f.cat[1].some(l => label.startsWith(l))];
}

function factorShare(f, rows) {
  let known = 0, yes = 0;
  for (const c of rows) {
    const [k, y] = factorOf(f, c);
    if (k) { known++; if (y) yes++; }
  }
  return { share: known ? yes / known : 0, yes, known };
}

function drawDriveCard(crashes, deaths, y0, y1) {
  const card = $("drive-card");
  if (y1 < POINT_FIRST_YEAR) { card.innerHTML = ""; return; }
  const { miles, files } = route.result;
  const first = Math.max(y0, POINT_FIRST_YEAR);
  const rows = crashes.map(m => m.c);
  const pct = d3.format(".0%");
  // Benchmark: every crash in the counties the drive passes through, same years and filters.
  const nearby = files.flatMap(f => f.crashes).filter(c => c[2] >= first && c[2] <= y1 && crashMatches(c));

  const { bins, size } = binsFor(crashes);
  const fmtMile = d3.format(size < 1 ? ",.1f" : ",.0f");
  const worst = bins.filter(b => b.crashes.length)
    .sort((a, b) => b.deaths - a.deaths || b.crashes.length - a.crashes.length).slice(0, 3);
  const stretchLines = worst.map(b => {
    const lead = ROUTE_FACTORS.map(f => ({ f, ...factorShare(f, b.crashes.map(m => m.c)) }))
      .filter(x => x.yes >= 3 && x.share >= 0.4).sort((a, b) => b.share - a.share)[0];
    return `<li><b>Miles ${fmtMile(b.lo)}–${fmtMile(b.hi)}</b>${b.road ? ` on ${b.road}` : ""}: ${fmtInt(b.deaths)} deaths` +
      (lead ? ` <span class="muted">(${pct(lead.share)} ${lead.f.phrase})</span>` : "") + "</li>";
  });

  const standouts = ROUTE_FACTORS.map(f => ({ f, r: factorShare(f, rows), b: factorShare(f, nearby) }))
    .filter(x => x.r.yes >= 5 && x.r.share >= x.b.share * 1.25 && x.r.share - x.b.share >= 0.05)
    .sort((a, b) => b.r.share / (b.b.share || 0.01) - a.r.share / (a.b.share || 0.01)).slice(0, 3);
  const standoutLines = standouts.length
    ? standouts.map(x => `<li><b>${x.f.label}:</b> ${pct(x.r.share)} of crashes on your route vs ${pct(x.b.share)} in the counties you pass through</li>`)
    : ["<li>No single factor stands out on this route compared with the surrounding counties.</li>"];

  const years = d3.range(first, y1 + 1);
  const perYear = years.map(y => rows.filter(c => c[2] === y).length);
  const change = perYear.at(-1) > perYear[0] * 1.15 ? "rising" : perYear.at(-1) < perYear[0] * 0.85 ? "falling" : "about steady";
  const trend = years.length > 1
    ? `${fmtInt(perYear[0])} crashes in ${years[0]} → ${fmtInt(perYear.at(-1))} in ${years.at(-1)} (${change})`
    : `${fmtInt(perYear[0])} crashes in ${years[0]}`;

  const tips = (standouts.length ? standouts.map(x => x.f.tip)
    : ["Crashes on this route follow the usual patterns: stay alert, keep to the limit, and never drive impaired or distracted."])
    .map(t => `<li>${t}</li>`);

  card.innerHTML = `
    <div class="drive-head">
      <div><span class="eyebrow">Your drive</span>
        <p class="drive-big"><b>${fmtInt(crashes.length)}</b> fatal crashes and <b>${fmtInt(deaths)}</b> deaths along your
          ${fmtRate(miles)}-mile drive, ${first}–${y1}</p>
        <p class="muted">About ${fmtRate(deaths / miles * 10)} deaths for every 10 miles of this route, counting crashes within
          ${$("r-buffer").value} m of it${filterActive() ? `, filtered to ${filterSummary()}` : ""}.</p></div>
      <div class="drive-trend"><span class="eyebrow">Trend</span><p>${trend}</p>${years.length > 1 ? sparkline(perYear) : ""}</div>
    </div>
    <div class="drive-cols">
      <div><h3>Worst stretches</h3><ul>${stretchLines.join("") || "<li>No crashes in these years.</li>"}</ul></div>
      <div><h3>What stands out</h3><ul>${standoutLines.join("")}</ul>
        <button type="button" class="link-btn" id="all-factors-btn" aria-expanded="${route.view.allFactors}">
          ${route.view.allFactors ? "Hide" : "See"} all statistics for this route</button></div>
      <div><h3>Driving tips</h3><ul>${tips.join("")}</ul></div>
      <div><h3>Places to take a break</h3>${stopsList(route.result)}</div>
    </div>
    ${route.view.allFactors ? allFactorsTable(rows, nearby, standouts) : ""}
    <p class="note">These are past crashes, not a prediction for your trip. Busy roads have more crashes partly because they carry more traffic.</p>`;
  $("all-factors-btn").onclick = () => {
    route.view.allFactors = !route.view.allFactors;
    drawDriveCard(crashes, deaths, y0, y1);
    if (route.view.allFactors) card.querySelector(".all-factors").scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
}

// Every factor and kind of crash, this route vs the counties it passes through, with paired bars.
function allFactorsTable(rows, nearby, standouts) {
  const pct = d3.format(".0%");
  const flagged = new Set(standouts.map(x => x.f));
  const bar = (v, cls) => `<span class="pair-bar ${cls}" style="width:${Math.round(Math.min(v, 1) * 100)}%"></span>`;
  const row = (label, r, b, note, mark) => `<tr class="${mark ? "stand" : ""}"><th scope="row">${label}${mark ? ' <span class="tag-best">stands out</span>' : ""}</th>
    <td class="num">${pct(r)}</td><td class="num">${pct(b)}</td><td class="bars">${bar(r, "you")}${bar(b, "near")}</td>
    <td class="muted small">${note}</td></tr>`;
  const factorRows = ROUTE_FACTORS.map(f => {
    const r = factorShare(f, rows), b = factorShare(f, nearby);
    const note = !r.known ? "not recorded in these years"
      : `${fmtInt(r.yes)} of ${fmtInt(r.known)} crashes${r.known < rows.length ? " where recorded" : ""}${r.known < 20 ? " (few, a rough guide)" : ""}`;
    return row(f.label, r.share, b.share, note, flagged.has(f));
  });
  const kindShare = (list, g) => list.length ? list.filter(c => crashGroup(c) === g).length / list.length : 0;
  const kindRows = CRASH_GROUPS.map(g => {
    const n = rows.filter(c => crashGroup(c) === g).length;
    return row(`<i class="kind-dot" style="background:${g.color}"></i>${g.label}`, kindShare(rows, g), kindShare(nearby, g), `${fmtInt(n)} crash${n === 1 ? "" : "es"}`, false);
  });
  const head = title => `<tr class="sub"><th colspan="5">${title}</th></tr>`;
  return `<div class="all-factors">
    <h3>All statistics for this route</h3>
    <p class="muted">Share of fatal crashes on your route (<span class="key you"></span>) and in the ${fmtInt(route.result.files.length)}
      counties it passes through (<span class="key near"></span>), same years and filters. Your route: ${fmtInt(rows.length)} crashes; counties: ${fmtInt(nearby.length)}.</p>
    <div class="table-wrap"><table class="factor-table">
      <thead><tr><th></th><th class="num">Your route</th><th class="num">Counties</th><th></th><th></th></tr></thead>
      <tbody>${head("Factors involved")}${factorRows.join("")}${head("Kind of crash")}${kindRows.join("")}</tbody>
    </table></div></div>`;
}

// ---------- rest stops (OpenStreetMap, downloaded by prep/rest_stops.py) ----------

const STOP_RANGE = 5000; // metres from the route line
let allStops = null;     // every U.S. rest area and travel center, loaded once

// Rest areas and travel centers within STOP_RANGE of a route, in route order, worked out once per route.
function loadStops(r) {
  r.stopsLoad ??= (async () => {
    allStops ??= d3.json("data/rest_stops.json");
    const data = await allStops;
    const lons = r.coords.map(p => p[0]), lats = r.coords.map(p => p[1]), pad = 0.06; // ~5 km
    const [s, w, n, e] = [d3.min(lats) - pad, d3.min(lons) - pad, d3.max(lats) + pad, d3.max(lons) + pad];
    const { segs } = buildSegments(r.coords);
    const found = [];
    for (const [lat, lon, kind, name, toilets] of data.stops) {
      if (lat < s || lat > n || lon < w || lon > e) continue;
      const near = nearestAlong(lon, lat, segs);
      if (near.dist > STOP_RANGE) continue;
      found.push({ lat, lon, mile: near.along / M_PER_MILE, off: near.dist / M_PER_MILE, kind: data.kinds[kind], name: name || data.kinds[kind], named: !!name,
                   toilets: !!toilets, n: 1 });
    }
    // The two sides of a highway rest area are often mapped separately; merge stops of the same kind close together.
    found.sort((a, b) => a.mile - b.mile);
    const stops = [];
    for (const s of found) {
      const prev = stops.findLast(p => p.kind === s.kind && Math.abs(p.mile - s.mile) < 0.5);
      if (prev) { prev.n++; prev.toilets ||= s.toilets; prev.off = Math.min(prev.off, s.off); } else stops.push(s);
    }
    r.stops = stops;
    return stops;
  })().catch(() => { r.stopsFailed = true; return []; });
  return r.stopsLoad;
}

// Distance (m) from a point to the nearest point on the route, and how far along the route that is.
function nearestAlong(lon, lat, segs) {
  let best = { dist: Infinity, along: 0 };
  for (const s of segs) {
    const px = (lon - s.lon0) * s.k * M_PER_DEG, py = (lat - s.lat0) * M_PER_DEG;
    const t = s.len ? Math.max(0, Math.min(1, (px * s.dx + py * s.dy) / (s.len * s.len))) : 0;
    const dist = Math.hypot(px - t * s.dx, py - t * s.dy);
    if (dist < best.dist) best = { dist, along: s.along + t * s.len };
  }
  return best;
}

function stopsList(r) {
  if (!route.view.stops) return `<p class="muted">Turn on <b>Rest stops</b> on the map to list them.</p>`;
  if (r.stopsFailed) return `<p class="muted">Rest-stop data isn't available (run <code>prep/rest_stops.py</code>).</p>`;
  if (!r.stops) return `<p class="muted">Looking up rest stops…</p>`;
  if (!r.stops.length) return `<p class="muted">No rest areas or travel centers within 5 km of this route on OpenStreetMap.</p>`;
  const shown = r.stops.slice(0, 6);
  const item = s => {
    const notes = [s.named ? s.kind.toLowerCase() : "", s.n > 1 ? "both sides" : "", s.toilets ? "restrooms" : "",
                   s.off >= 0.3 ? `${fmtRate(s.off)} mi off route` : ""].filter(Boolean);
    return `<li><b>Mile ${fmtRate(s.mile)}:</b> ${s.named ? s.name : `Unnamed ${s.kind.toLowerCase()}`}` +
      (notes.length ? ` <span class="muted">(${notes.join(", ")})</span>` : "") + "</li>";
  };
  return `<ul>${shown.map(item).join("")}</ul>` +
    (r.stops.length > shown.length ? `<p class="muted">${r.stops.length - shown.length} more on the map.</p>` : "");
}

function drawStops() {
  const r = route.result;
  if (!route.view.stops || !r) return;
  if (!r.stops) {
    if (!r.stopsFailed) loadStops(r).then(() => { if (route.result === r) refreshRoute(); });
    return;
  }
  for (const s of r.stops) {
    L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: `stop-icon${s.kind === "Rest area" ? "" : " travel"}`, html: "P", iconSize: [20, 20] }),
      title: s.name, zIndexOffset: 500,
    }).bindTooltip(`<b>${s.name}</b><div class="row"><span>${s.kind}</span>mile ${fmtRate(s.mile)}</div>` +
      (s.n > 1 ? `<div class="row"><span>Sides</span>both directions</div>` : "") +
      (s.toilets ? `<div class="row"><span>Restrooms</span>yes</div>` : ""), { direction: "top", offset: [0, -8], className: "crash-tip" })
      .addTo(route.layers);
  }
}

// "Rest stops" switch on the route map (on by default).
function addStopsToggle(map) {
  route.view.stops = true;
  const Ctl = L.Control.extend({
    onAdd() {
      const box = L.DomUtil.create("label", "map-check");
      box.innerHTML = `<input type="checkbox" checked> Rest stops <span class="stop-icon" aria-hidden="true">P</span>`;
      L.DomEvent.disableClickPropagation(box);
      box.querySelector("input").addEventListener("change", e => { route.view.stops = e.target.checked; refreshRoute(); });
      return box;
    },
  });
  new Ctl({ position: "topright" }).addTo(map);
}

function sparkline(values) {
  const w = 160, h = 34, x = d3.scaleLinear([0, values.length - 1], [3, w - 3]);
  const y = d3.scaleLinear([0, d3.max(values) || 1], [h - 3, 3]);
  const line = d3.line().x((v, i) => x(i)).y(v => y(v));
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Crashes per year on this route">` +
    `<path d="${line(values)}"/><circle cx="${x(values.length - 1)}" cy="${y(values.at(-1))}" r="3"/></svg>`;
}
