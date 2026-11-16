// County road view: every geolocated crash in the selected county on a street basemap,
// plus a ranking of the deadliest roads. Uses `ui`, `darkQuery`, fmtInt from main.js.

const POINT_FIRST_YEAR = 2001;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HIGHLIGHT = { light: "#eb6834", dark: "#ff8a5c" }; // categorical slot 2, distinct from the blue dots

const detail = {
  fips: null, name: null, data: null, road: null, request: 0,
  map: null, tiles: null, outline: null, points: null, shapes: null, view: { heat: false, groups: new Set() },
  spot: null, // selected dangerous spot: { members: Set of crash rows, lat, lon }
};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Leaflet map on a gray street basemap that follows light/dark mode; shared with route.js.
function createStreetMap(el, onThemeChange) {
  const map = L.map(el, { preferCanvas: true, zoomSnap: 0.25, maxZoom: 16 });
  // Road-name labels sit above the crash dots so they stay readable.
  map.createPane("labels").style.zIndex = 650;
  map.getPane("labels").style.pointerEvents = "none";
  let tiles = [];
  const setTiles = () => {
    tiles.forEach(t => t.remove());
    const shade = darkQuery.matches ? "Dark" : "Light";
    const url = layer => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${shade}_Gray_${layer}/MapServer/tile/{z}/{y}/{x}`;
    tiles = [
      L.tileLayer(url("Base"), { maxZoom: 16, attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors" }),
      L.tileLayer(url("Reference"), { maxZoom: 16, pane: "labels" }),
    ];
    tiles.forEach(t => t.addTo(map));
  };
  setTiles();
  darkQuery.addEventListener("change", () => { setTiles(); onThemeChange(); });
  return map;
}

// "Dots | Heat map" switch plus a legend shown in heat mode, for both street maps.
// view.heat says which mode is on; redraw() repaints the map's crashes.
const HEAT_GRADIENT = { 0.25: "#4c6ef5", 0.5: "#7c4ddb", 0.7: "#d6336c", 0.85: "#f08c00", 1: "#ffd43b" };

function addHeatToggle(map, view, redraw) {
  const Toggle = L.Control.extend({
    onAdd() {
      const box = L.DomUtil.create("div", "map-toggle");
      box.innerHTML = `<button type="button" data-mode="dots" class="on">Dots</button>` +
        `<button type="button" data-mode="heat" title="Shows where fatal crashes cluster: brighter areas had more">Heat map</button>`;
      L.DomEvent.disableClickPropagation(box);
      box.addEventListener("click", e => {
        const mode = e.target.dataset.mode;
        if (!mode) return;
        view.heat = mode === "heat";
        box.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
        legend.getContainer().hidden = !view.heat;
        view.typeLegend.hidden = view.heat;
        redraw();
      });
      return box;
    },
  });
  const Legend = L.Control.extend({
    onAdd() {
      const box = L.DomUtil.create("div", "heat-legend");
      const stops = Object.entries(HEAT_GRADIENT).map(([k, c]) => `${c} ${k * 100}%`).join(", ");
      box.innerHTML = `<span>Fewer</span><i style="background:linear-gradient(90deg, #dbe4ff 0%, ${stops})"></i><span>More fatal crashes</span>`;
      box.hidden = true;
      return box;
    },
  });
  const Types = L.Control.extend({
    onAdd() {
      const box = L.DomUtil.create("div", "type-legend");
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      return box;
    },
  });
  new Toggle({ position: "topright" }).addTo(map);
  const legend = new Legend({ position: "bottomleft" }).addTo(map);
  view.typeLegend = new Types({ position: "bottomleft" }).addTo(map).getContainer();
}

// Heat layer for a list of crash rows; each crash counts once, weighted a little by deaths. The
// ceiling grows with the number of crashes so a busy county isn't one solid blob of the hottest color.
function heatLayer(rows) {
  return L.heatLayer(rows.map(c => [c[0], c[1], 0.6 + 0.4 * Math.min(c[5], 3)]),
    { radius: 16, blur: 18, maxZoom: 9, max: Math.max(2, rows.length / 60), minOpacity: 0.3, gradient: HEAT_GRADIENT });
}

// Crash types grouped into seven kinds a driver recognizes, colored with the color-blind-safe
// Okabe-Ito palette (minus yellow, which washes out on the light map). Codes are crash_type values.
const CRASH_GROUPS = [
  { key: "headon", label: "Head-on or oncoming", color: "#D55E00", codes: [1, 10] },
  { key: "rear", label: "Rear-end", color: "#E69F00", codes: [2] },
  { key: "angle", label: "Angle (often at intersections)", color: "#CC79A7", codes: [3] },
  { key: "lane", label: "Lane change or merge", color: "#56B4E9", codes: [4] },
  { key: "ped", label: "Pedestrian or cyclist", color: "#009E73", codes: [6, 7] },
  { key: "single", label: "Single vehicle (ran off road, rollover)", color: "#0072B2", codes: [8, 9] },
  { key: "other", label: "Other or unknown", color: "#999999", codes: [0, 5] },
];
const GROUP_OF_CODE = new Map(CRASH_GROUPS.flatMap(g => g.codes.map(code => [code, g])));
const crashGroup = c => GROUP_OF_CODE.get(catValue(c[7], "crash_type")) ?? CRASH_GROUPS.at(-1);

// Crash dot: colored by kind of crash, sized by deaths, with a light ring.
function crashMarker(c, opts = {}) {
  return L.circleMarker([c[0], c[1]], {
    radius: 3 + 2 * Math.sqrt(c[5]),
    color: "#ffffff", weight: 1,
    fillColor: crashGroup(c).color, fillOpacity: 0.85,
    ...opts,
  });
}

// Style for a dot given what's spotlighted: picked crashes get a dark outline, others fade.
function dotStyle(spotlit, picked) {
  if (!spotlit) return { fillOpacity: 0.12, opacity: 0.25 };
  return picked ? { color: cssVar("--ink"), weight: 2, fillOpacity: 0.95 } : {};
}

// Legend of crash kinds shown on the map. Lists only kinds present, with counts. Clicking kinds
// spotlights them; several can be on at once, and "Show all" clears them.
const kindOn = (view, c) => !view.groups.size || view.groups.has(crashGroup(c).key);

function updateTypeLegend(view, rows, redraw) {
  const box = view.typeLegend;
  if (!box) return;
  const counts = d3.rollup(rows, v => v.length, c => crashGroup(c).key);
  const items = CRASH_GROUPS.filter(g => counts.get(g.key));
  for (const key of view.groups) if (!counts.get(key)) view.groups.delete(key);
  const any = view.groups.size > 0;
  box.innerHTML = `<b>Kind of crash</b>` + items.map(g =>
    `<button type="button" data-key="${g.key}" aria-pressed="${view.groups.has(g.key)}" class="${view.groups.has(g.key) ? "on" : any ? "dim" : ""}">` +
    `<i style="background:${g.color}"></i>${g.label}<span>${fmtInt(counts.get(g.key))}</span></button>`).join("") +
    (any ? `<button type="button" data-key="all" class="show-all">Show all kinds</button>`
         : `<small>Click kinds to spotlight them (pick as many as you like)</small>`);
  box.onclick = e => {
    const key = e.target.closest("button")?.dataset.key;
    if (!key) return;
    if (key === "all") view.groups.clear();
    else if (!view.groups.delete(key)) view.groups.add(key);
    redraw();
  };
}

function initRoadMap() {
  detail.map = createStreetMap("roadmap", drawPoints);
  detail.points = L.layerGroup().addTo(detail.map);
  addHeatToggle(detail.map, detail.view, drawPoints);
}

// Geolocated crashes for one county, fetched once and shared by the road, route and compare views.
const countyFiles = new Map();
function loadCountyCrashes(fips) {
  if (!countyFiles.has(fips)) {
    countyFiles.set(fips, d3.json(`data/crashes/${fips}.json`).catch(() => ({ roads: [], crashes: [] })));
  }
  return countyFiles.get(fips);
}

// Unprojected (lon/lat) county polygons, loaded once; also used by route.js.
function countyShapes() {
  detail.shapes ??= d3.json("https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-10m.json")
    .then(us => topojson.feature(us, us.objects.counties).features);
  return detail.shapes;
}

async function countyShape(fips) {
  return (await countyShapes()).find(f => +f.id === fips);
}

async function showCountyDetail(fips, name, scroll = true) {
  const section = $("detail");
  section.hidden = false;
  // Leaflet can't size a map inside a collapsed section, so a county click always opens it.
  reveal(section, false);
  if (!detail.map) initRoadMap();
  detail.map.invalidateSize();
  if (scroll) section.scrollIntoView({ behavior: "smooth", block: "start" });
  if (fips === detail.fips) return;

  const request = ++detail.request;
  Object.assign(detail, { fips, name, data: null, road: null, spot: null });
  $("d-title").textContent = name;
  $("d-sub").textContent = "Loading crashes…";
  detail.points.clearLayers();
  d3.select("#roads tbody").html("");

  const [data, shape] = await Promise.all([
    loadCountyCrashes(fips),
    countyShape(fips),
  ]);
  if (request !== detail.request) return; // a newer county was clicked meanwhile

  detail.data = data;
  detail.outline?.remove();
  detail.outline = shape && L.geoJSON(shape, {
    interactive: false,
    style: { fill: false, color: cssVar("--ink-2"), weight: 2, dashArray: "6 4" },
  }).addTo(detail.map);
  fitCounty();
  refreshCountyDetail();
}

function fitCounty() {
  const bounds = detail.outline?.getBounds();
  if (bounds?.isValid()) detail.map.fitBounds(bounds, { padding: [16, 16] });
}

function hideCountyDetail() {
  $("detail").hidden = true;
  detail.fips = null;
  detail.request++;
}

// Row layout: [lat, lon, year, month, hour, fatals, road, cats, flags, dow]
function crashMatches(c) {
  return filters.match(c[7], c[8], c[4], c[9]);
}

function filteredCrashes() {
  const y0 = Math.max(+ui.y0.value, POINT_FIRST_YEAR), y1 = +ui.y1.value;
  return detail.data.crashes.filter(c => c[2] >= y0 && c[2] <= y1 && crashMatches(c));
}

// Called from main.js render() so the year range / measure controls apply here too.
function refreshCountyDetail() {
  if (!detail.data || $("detail").hidden) return;
  const y0 = +ui.y0.value, y1 = +ui.y1.value;
  const crashes = filteredCrashes();
  const deaths = d3.sum(crashes, c => c[5]);

  $("d-sub").textContent = y1 < POINT_FIRST_YEAR
    ? `Crash locations are only recorded from ${POINT_FIRST_YEAR} on. Pick a later year range.`
    : `${fmtInt(crashes.length)} fatal crashes, ${fmtInt(deaths)} deaths, ${Math.max(y0, POINT_FIRST_YEAR)}–${y1}` +
      (y0 < POINT_FIRST_YEAR ? ` (locations not recorded before ${POINT_FIRST_YEAR})` : "") +
      (filterActive() ? `. Filtered: ${filterSummary()}` : "");

  drawRoadTable(crashes);
  drawSpotTable(crashes);
  drawPoints();
}

function drawRoadTable(crashes) {
  const byDeaths = ui.measure.value === "fatals";
  const roads = d3.rollups(crashes, v => ({ crashes: v.length, deaths: d3.sum(v, c => c[5]) }), c => c[6])
    .map(([road, s]) => ({ road, name: detail.data.roads[road], ...s }))
    .sort((a, b) => byDeaths ? b.deaths - a.deaths || b.crashes - a.crashes : b.crashes - a.crashes || b.deaths - a.deaths)
    .slice(0, 15);
  $("tab-roads").textContent = byDeaths ? "Deadliest roads" : "Roads with most crashes";

  d3.select("#roads tbody").selectAll("tr").data(roads, r => r.road).join("tr")
    .classed("active", r => r.road === detail.road)
    .on("click", (e, r) => highlightRoad(r.road === detail.road ? null : r.road, true))
    .html((r, i) => `<td>${i + 1}</td><td>${r.name}</td><td class="num">${fmtInt(r.crashes)}</td><td class="num">${fmtInt(r.deaths)}</td>`);
}

function drawPoints() {
  if (!detail.data) return;
  detail.points.clearLayers();
  const crashes = filteredCrashes();
  const picked = detail.spot ? c => detail.spot.members.has(c) : detail.road !== null ? c => c[6] === detail.road : null;
  updateTypeLegend(detail.view, picked ? crashes.filter(picked) : crashes, drawPoints);
  const on = c => (!picked || picked(c)) && kindOn(detail.view, c);
  if (detail.view.heat) return heatLayer(crashes.filter(on)).addTo(detail.points);
  // Draw the spotlighted crashes last so they sit on top.
  for (const c of [...crashes.filter(c => !on(c)), ...crashes.filter(on)]) {
    crashMarker(c, dotStyle(on(c), !!picked && on(c)))
      .bindTooltip(crashTip(c, detail.data.roads), { direction: "top", offset: [0, -4], className: "crash-tip" })
      .on("click", () => highlightRoad(c[6] === detail.road ? null : c[6], false))
      .addTo(detail.points);
  }
}

function crashTip(c, roads, extra = "") {
  const [, , year, month, hour, fatals, road, cats, flags] = c;
  const when = `${MONTHS[month - 1] ?? ""} ${year}` + (hour < 24 ? `, ${d3.timeFormat("%-I %p")(new Date(2000, 0, 1, hour))}` : "");
  return `<b>${roads[road]}</b>` + extra +
    `<div class="row"><span>When</span>${when}</div>` +
    `<div class="row"><span>Deaths</span>${fatals}</div>` +
    describeCrash(cats, flags);
}

function highlightRoad(road, zoom) {
  detail.road = road;
  detail.spot = null;
  d3.selectAll("#spots tbody tr").classed("active", false);
  d3.selectAll("#roads tbody tr").classed("active", r => r.road === road);
  drawPoints();
  if (!zoom) return;
  if (road === null) return fitCounty();
  const pts = filteredCrashes().filter(c => c[6] === road).map(c => [c[0], c[1]]);
  if (pts.length) detail.map.fitBounds(L.latLngBounds(pts), { padding: [32, 32], maxZoom: 15 });
}

$("d-back").addEventListener("click", () => reveal($("map"), true, "center"));
$("d-clear").addEventListener("click", () => highlightRoad(null, true));
for (const tab of ["roads", "spots"]) {
  $(`tab-${tab}`).addEventListener("click", () => {
    for (const t of ["roads", "spots"]) {
      $(`tab-${t}`).classList.toggle("on", t === tab);
      $(`tab-${t}`).setAttribute("aria-selected", String(t === tab));
      $(`pane-${t}`).hidden = t !== tab;
    }
  });
}

// ---------- most dangerous spots ----------

const SPOT_CELL = 0.0005; // degrees of latitude, about 55 m; a spot is a 3 x 3 block of cells (~165 m)

// Places where several crashes happened close together, ranked by deaths. Greedy: take the busiest
// block, claim its cells, repeat, so neighbouring spots don't double-count the same crashes.
function dangerousSpots(crashes, limit = 15) {
  if (!crashes.length) return [];
  const k = Math.cos(d3.mean(crashes, c => c[0]) * Math.PI / 180);
  const cellOf = c => [Math.floor(c[0] / SPOT_CELL), Math.floor(c[1] * k / SPOT_CELL)];
  const cells = new Map();
  for (const c of crashes) {
    const [i, j] = cellOf(c), key = `${i},${j}`;
    if (!cells.has(key)) cells.set(key, { i, j, rows: [] });
    cells.get(key).rows.push(c);
  }
  const block = ({ i, j }) => {
    const rows = [], keys = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const cell = cells.get(`${i + di},${j + dj}`);
      if (cell && !cell.used) { rows.push(...cell.rows); keys.push(`${i + di},${j + dj}`); }
    }
    return { rows, keys };
  };
  const spots = [];
  const order = [...cells.values()].map(cell => ({ cell, ...block(cell) }))
    .sort((a, b) => d3.sum(b.rows, c => c[5]) - d3.sum(a.rows, c => c[5]) || b.rows.length - a.rows.length);
  for (const { cell } of order) {
    if (cell.used) continue;
    const { rows, keys } = block(cell);
    if (rows.length < 2) continue;
    keys.forEach(key => { cells.get(key).used = true; });
    spots.push({ rows, members: new Set(rows), deaths: d3.sum(rows, c => c[5]),
                 lat: d3.mean(rows, c => c[0]), lon: d3.mean(rows, c => c[1]) });
  }
  return spots.sort((a, b) => b.deaths - a.deaths || b.rows.length - a.rows.length).slice(0, limit);
}

// "I-45 & FM-1960" when the crashes are split across two roads, otherwise one road name.
function spotName(spot) {
  const roads = d3.rollups(spot.rows, v => v.length, c => detail.data.roads[c[6]])
    .filter(([name]) => name && name !== "Unknown road").sort((a, b) => b[1] - a[1]);
  if (!roads.length) return "Unnamed road";
  // "GESSNER DR" and "GESSNER RD" are one road spelled two ways.
  const base = name => name.replace(/\b(RD|DR|ST|AVE|BLVD|LN|HWY|PKWY|CT|PL|WAY|FWY)\b/g, "").trim();
  const other = roads.find(([name]) => base(name) !== base(roads[0][0]));
  return other ? `${roads[0][0]} & ${other[0]}` : roads[0][0];
}

function drawSpotTable(crashes) {
  const spots = dangerousSpots(crashes);
  $("spots-empty").hidden = spots.length > 0;
  d3.select("#spots tbody").selectAll("tr").data(spots).join("tr")
    .classed("active", s => detail.spot && s.lat === detail.spot.lat && s.lon === detail.spot.lon)
    .on("click", (e, s) => selectSpot(detail.spot && s.lat === detail.spot.lat ? null : s))
    .html((s, i) => `<td>${i + 1}</td><td>${spotName(s)}</td><td class="num">${fmtInt(s.rows.length)}</td><td class="num">${fmtInt(s.deaths)}</td>`);
}

function selectSpot(spot) {
  detail.spot = spot;
  detail.road = null;
  d3.selectAll("#roads tbody tr").classed("active", false);
  d3.selectAll("#spots tbody tr").classed("active", s => spot && s.lat === spot.lat && s.lon === spot.lon);
  drawPoints();
  if (spot) detail.map.setView([spot.lat, spot.lon], 16);
  else fitCounty();
}
