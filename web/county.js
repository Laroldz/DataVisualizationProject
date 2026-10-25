// County road view: every geolocated crash in the selected county on a street basemap,
// plus a ranking of the deadliest roads. Uses `ui`, `darkQuery`, fmtInt from main.js.

const POINT_FIRST_YEAR = 2001;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HIGHLIGHT = { light: "#eb6834", dark: "#d95926" }; // categorical slot 2, distinct from the blue dots

const detail = {
  fips: null, name: null, data: null, road: null, request: 0,
  map: null, tiles: null, outline: null, points: null, shapes: null,
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

// Crash dot: blue, sized by deaths, with a surface-colored ring.
function crashMarker(c, opts = {}) {
  return L.circleMarker([c[0], c[1]], {
    radius: 3 + 2 * Math.sqrt(c[5]),
    color: cssVar("--surface"), weight: 1,
    fillColor: cssVar("--series-1"), fillOpacity: 0.8,
    ...opts,
  });
}

function initRoadMap() {
  detail.map = createStreetMap("roadmap", drawPoints);
  detail.points = L.layerGroup().addTo(detail.map);
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

async function showCountyDetail(fips, name) {
  const section = $("detail");
  section.hidden = false;
  if (!detail.map) initRoadMap();
  detail.map.invalidateSize();
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  if (fips === detail.fips) return;

  const request = ++detail.request;
  Object.assign(detail, { fips, name, data: null, road: null });
  $("d-title").textContent = name;
  $("d-sub").textContent = "Loading crashes…";
  detail.points.clearLayers();
  d3.select("#roads tbody").html("");

  const [data, shape] = await Promise.all([
    d3.json(`data/crashes/${fips}.json`).catch(() => ({ roads: [], crashes: [] })),
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
  drawPoints();
}

function drawRoadTable(crashes) {
  const byDeaths = ui.measure.value === "fatals";
  const roads = d3.rollups(crashes, v => ({ crashes: v.length, deaths: d3.sum(v, c => c[5]) }), c => c[6])
    .map(([road, s]) => ({ road, name: detail.data.roads[road], ...s }))
    .sort((a, b) => byDeaths ? b.deaths - a.deaths || b.crashes - a.crashes : b.crashes - a.crashes || b.deaths - a.deaths)
    .slice(0, 15);
  $("roads-title").textContent = byDeaths ? "Deadliest roads" : "Roads with the most fatal crashes";

  d3.select("#roads tbody").selectAll("tr").data(roads, r => r.road).join("tr")
    .classed("active", r => r.road === detail.road)
    .on("click", (e, r) => highlightRoad(r.road === detail.road ? null : r.road, true))
    .html((r, i) => `<td>${i + 1}</td><td>${r.name}</td><td class="num">${fmtInt(r.crashes)}</td><td class="num">${fmtInt(r.deaths)}</td>`);
}

function drawPoints() {
  if (!detail.data) return;
  detail.points.clearLayers();
  const hl = darkQuery.matches ? HIGHLIGHT.dark : HIGHLIGHT.light;
  const crashes = filteredCrashes();
  const on = c => detail.road === null || c[6] === detail.road;
  // Draw the highlighted road last so it sits on top.
  for (const c of [...crashes.filter(c => !on(c)), ...crashes.filter(on)]) {
    const active = detail.road !== null && on(c);
    crashMarker(c, {
      ...(active && { fillColor: hl }),
      fillOpacity: on(c) ? 0.8 : 0.15,
      opacity: on(c) ? 1 : 0.3,
    })
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
  d3.selectAll("#roads tbody tr").classed("active", r => r.road === road);
  drawPoints();
  if (!zoom) return;
  if (road === null) return fitCounty();
  const pts = filteredCrashes().filter(c => c[6] === road).map(c => [c[0], c[1]]);
  if (pts.length) detail.map.fitBounds(L.latLngBounds(pts), { padding: [32, 32], maxZoom: 15 });
}

$("d-back").addEventListener("click", () => $("map").scrollIntoView({ behavior: "smooth", block: "center" }));
$("d-clear").addEventListener("click", () => highlightRoad(null, true));
