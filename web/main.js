const FIRST_YEAR = 1975, LAST_YEAR = 2024, N = LAST_YEAR - FIRST_YEAR + 1;
const RAMP_LIGHT = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const RAMP_DARK = [...RAMP_LIGHT].reverse(); // low values recede into the dark surface

const fmtInt = d3.format(",");
const fmtRate = d3.format(",.1f");
const NORM_LABEL = { smoothed: "Smoothed rate per 100k / yr", rate: "Rate per 100k / yr", count: "Total" };
const MEASURE_LABEL = { fatals: "fatalities", crashes: "fatal crashes" };

const $ = id => document.getElementById(id);
const ui = { level: $("level"), measure: $("measure"), norm: $("norm"), y0: $("y0"), y1: $("y1") };
const tooltip = $("tooltip");
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

const state = { selected: null, focusState: null }; // selected = {level, id}
let data, counties, states, nameOf, values, nationalSeries;

// ---------- data ----------

function series() {
  return { crashes: new Float64Array(N), fatals: new Float64Array(N), pop: new Float64Array(N) };
}

function index(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const id = +r[key];
    if (!m.has(id)) m.set(id, series());
    const s = m.get(id), i = +r.year - FIRST_YEAR;
    s.crashes[i] = +r.crashes; s.fatals[i] = +r.fatals; s.pop[i] = +r.pop;
  }
  return m;
}

function sum(arr, i0, i1) {
  let t = 0;
  for (let i = i0; i <= i1; i++) t += arr[i];
  return t;
}

// Empirical Bayes (Marshall 1991, method of moments): shrink each unit's rate toward
// its group's rate, by an amount that grows as the unit's population shrinks.
function smooth(units) {
  const E = d3.sum(units, u => u.E), P = d3.sum(units, u => u.P);
  if (!P) return;
  const m = E / P;
  const s2 = d3.sum(units, u => u.P * (u.E / u.P - m) ** 2) / P;
  const A = Math.max(0, s2 - m / (P / units.length));
  for (const u of units) {
    const w = A + m / u.P > 0 ? A / (A + m / u.P) : 1;
    u.smoothed = (m + w * (u.E / u.P - m)) * 1e5;
  }
}

function compute() {
  const level = ui.level.value, measure = ui.measure.value, norm = ui.norm.value;
  const i0 = +ui.y0.value - FIRST_YEAR, i1 = +ui.y1.value - FIRST_YEAR;
  const source = level === "county" ? data.county : data.state;
  const out = new Map();
  for (const [id, s] of source) {
    const P = sum(s.pop, i0, i1);
    if (!P) continue;
    const E = sum(s[measure], i0, i1);
    out.set(id, { id, E, P, rate: E / P * 1e5 });
  }
  // County rates shrink toward their state; state rates shrink toward the nation.
  const groups = d3.group(out.values(), u => level === "county" ? Math.floor(u.id / 1000) : 0);
  for (const g of groups.values()) smooth(g);
  for (const u of out.values()) u.value = norm === "count" ? u.E : norm === "rate" ? u.rate : u.smoothed;
  return out;
}

// ---------- map ----------

const svg = d3.select("#map");
const root = svg.append("g");
const path = d3.geoPath();
const gCounties = root.append("g");
const gStates = root.append("g");
const bordersPath = root.append("path").attr("class", "borders");
const outline = root.append("path").attr("class", "selected-outline");

const zoom = d3.zoom().scaleExtent([1, 12])
  .on("zoom", e => root.attr("transform", e.transform));
svg.call(zoom).on("dblclick.zoom", null);

function zoomTo(feature) {
  const [[x0, y0], [x1, y1]] = path.bounds(feature);
  const k = Math.min(12, 0.85 / Math.max((x1 - x0) / 975, (y1 - y0) / 610));
  svg.transition().duration(750).call(zoom.transform,
    d3.zoomIdentity.translate(975 / 2, 610 / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
}

function drawMap(us) {
  counties = topojson.feature(us, us.objects.counties).features;
  states = topojson.feature(us, us.objects.states).features;
  const stateName = new Map(states.map(f => [+f.id, f.properties.name]));
  nameOf = (level, id) => level === "state"
    ? stateName.get(id) ?? `State ${id}`
    : `${counties.find(f => +f.id === id)?.properties.name ?? `County ${id}`}, ${stateName.get(Math.floor(id / 1000)) ?? ""}`;

  gCounties.selectAll("path").data(counties).join("path")
    .attr("class", "area").attr("d", path)
    .on("mousemove", (e, f) => showTip(e, "county", +f.id))
    .on("mouseleave", hideTip)
    .on("click", (e, f) => select("county", +f.id));

  gStates.selectAll("path").data(states).join("path")
    .attr("class", "area").attr("d", path)
    .on("mousemove", (e, f) => showTip(e, "state", +f.id))
    .on("mouseleave", hideTip)
    .on("click", (e, f) => {
      // Drill down: switch to counties, zoom to the state.
      ui.level.value = "county";
      state.focusState = +f.id;
      select("state", +f.id);
      zoomTo(f);
    });

  bordersPath.datum(topojson.mesh(us, us.objects.states, (a, b) => a !== b)).attr("d", path);
}

function render() {
  const level = ui.level.value, norm = ui.norm.value;
  values = compute();
  const ramp = darkQuery.matches ? RAMP_DARK : RAMP_LIGHT;
  const vals = [...values.values()].map(u => u.value).filter(Number.isFinite);
  const color = d3.scaleQuantile(vals, ramp);

  gCounties.style("display", level === "county" ? null : "none");
  gStates.style("display", level === "state" ? null : "none");
  const layer = level === "county" ? gCounties : gStates;
  layer.selectAll("path")
    .classed("nodata", f => !values.has(+f.id))
    .attr("fill", f => values.has(+f.id) ? color(values.get(+f.id).value) : null);

  drawOutline();
  drawLegend(color, norm);
  drawRanking(level, norm);
  drawPanel();
  refreshCountyDetail();
  $("note").textContent = norm === "smoothed"
    ? `Smoothed rates use empirical Bayes: low-population ${level === "county" ? "counties are pulled toward their state's" : "states are pulled toward the national"} rate, so a single crash can't produce an extreme value. Colors are quantile bins (each holds ~1/7 of areas).`
    : norm === "rate"
      ? "Unsmoothed rates: very small counties can show extreme values from just one or two crashes. Colors are quantile bins."
      : "Raw counts mostly track population. Switch to a rate to compare areas fairly.";
}

function drawOutline() {
  const s = state.selected;
  const f = s && (s.level === "county" ? counties : states).find(f => +f.id === s.id);
  outline.attr("d", f ? path(f) : null);
}

function drawLegend(color, norm) {
  const fmt = norm === "count" ? d3.format(",.0f") : fmtRate;
  const lo = color.domain().length ? d3.min(color.domain()) : 0;
  const cuts = [lo, ...color.quantiles()];
  const legend = d3.select("#legend").html("");
  legend.append("span").attr("class", "title").text(`${NORM_LABEL[norm]} (${MEASURE_LABEL[ui.measure.value]})`);
  color.range().forEach((c, i) => {
    const bin = legend.append("div").attr("class", "bin");
    bin.append("div").attr("class", "sw").style("background", c);
    bin.append("span").text(i === 0 ? "" : `${fmt(cuts[i])}+`);
  });
  legend.append("span").attr("class", "nd").html("<i></i>No data");
}

function drawRanking(level, norm) {
  const fmt = norm === "count" ? fmtInt : fmtRate;
  let rows = [...values.values()];
  if (level === "county" && state.focusState) rows = rows.filter(u => Math.floor(u.id / 1000) === state.focusState);
  rows = rows.sort((a, b) => b.value - a.value).slice(0, 10);
  const where = level === "county" && state.focusState ? ` in ${nameOf("state", state.focusState)}` : "";
  $("rank-title").textContent = `Top 10 ${level === "county" ? "counties" : "states"}${where}`;
  $("rank-col").textContent = norm === "count" ? "Total" : "Per 100k";
  const nYears = +ui.y1.value - +ui.y0.value + 1;
  d3.select("#rank tbody").selectAll("tr").data(rows).join("tr")
    .on("click", (e, u) => select(level, u.id))
    .html((u, i) => `<td>${i + 1}</td><td>${nameOf(level, u.id)}</td><td class="num">${fmt(u.value)}</td><td class="num">${d3.format(".3~s")(u.P / nYears)}</td>`);
}

// ---------- side panel ----------

function selectedSeries() {
  const s = state.selected;
  if (!s) return null;
  return (s.level === "county" ? data.county : data.state).get(s.id);
}

function drawPanel() {
  const measure = ui.measure.value;
  const i0 = +ui.y0.value - FIRST_YEAR, i1 = +ui.y1.value - FIRST_YEAR, nYears = i1 - i0 + 1;
  const s = state.selected;
  const ser = selectedSeries() ?? nationalSeries;
  const E = sum(ser[measure], i0, i1), P = sum(ser.pop, i0, i1);
  const natRate = sum(nationalSeries[measure], i0, i1) / sum(nationalSeries.pop, i0, i1) * 1e5;
  const u = s && s.level === ui.level.value ? values.get(s.id) : null;

  $("sel-title").textContent = s ? nameOf(s.level, s.id) : "United States";
  const stats = [
    [`Total ${MEASURE_LABEL[measure]}, ${ui.y0.value}–${ui.y1.value}`, fmtInt(E)],
    ["Avg. population", d3.format(",.0f")(P / nYears)],
    ["Rate per 100k / yr", P ? fmtRate(E / P * 1e5) : "–"],
    s ? ["Smoothed rate", u?.smoothed != null ? fmtRate(u.smoothed) : "–"] : null,
    s ? ["U.S. rate", fmtRate(natRate)] : null,
  ].filter(Boolean);
  $("sel-stats").innerHTML = stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
  drawTrend(s ? ser : null, measure);
}

const trend = d3.select("#trend");
const T = { w: 360, h: 200, m: { t: 10, r: 70, b: 22, l: 32 } };

function drawTrend(ser, measure) {
  const rateAt = (s, i) => s.pop[i] ? s[measure][i] / s.pop[i] * 1e5 : null;
  const years = d3.range(N);
  const nat = years.map(i => rateAt(nationalSeries, i));
  const sel = ser ? years.map(i => rateAt(ser, i)) : null;

  const x = d3.scaleLinear([FIRST_YEAR, LAST_YEAR], [T.m.l, T.w - T.m.r]);
  const y = d3.scaleLinear([0, d3.max([...nat, ...(sel ?? [])]) || 1], [T.h - T.m.b, T.m.t]).nice();
  const line = d3.line().defined(v => v != null).x((v, i) => x(FIRST_YEAR + i)).y(v => y(v));

  trend.html("");
  trend.append("rect").attr("class", "range")
    .attr("x", x(+ui.y0.value) - 2).attr("width", x(+ui.y1.value) - x(+ui.y0.value) + 4)
    .attr("y", T.m.t).attr("height", T.h - T.m.b - T.m.t);
  trend.append("g").attr("class", "grid").attr("transform", `translate(${T.m.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(-(T.w - T.m.l - T.m.r)))
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--grid)"));
  trend.append("g").attr("transform", `translate(0,${T.h - T.m.b})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(d3.format("d")).tickSizeOuter(0))
    .call(g => g.select(".domain").attr("stroke", "var(--axis)"))
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--axis)"));

  const lastY = arr => y(arr.findLast(v => v != null) ?? 0);
  let yNat = lastY(nat), ySel = sel ? lastY(sel) : null;
  if (sel && Math.abs(ySel - yNat) < 14) { // push end labels apart
    const mid = (ySel + yNat) / 2, dir = ySel <= yNat ? -1 : 1;
    ySel = mid + dir * 7; yNat = mid - dir * 7;
  }
  trend.append("path").attr("class", sel ? "national" : "series").attr("d", line(nat));
  trend.append("text").attr("class", "label").attr("x", T.w - T.m.r + 4).attr("y", yNat).attr("dy", "0.35em").text("U.S.");
  if (sel) {
    trend.append("path").attr("class", "series").attr("d", line(sel));
    trend.append("text").attr("class", "label sel").attr("x", T.w - T.m.r + 4).attr("y", ySel).attr("dy", "0.35em").text("Selected");
  }
  trend.append("text").attr("x", T.m.l).attr("y", T.m.t - 2).text(`${MEASURE_LABEL[measure]} per 100k / yr`);

  // Crosshair + tooltip
  const cross = trend.append("line").attr("class", "cross").attr("y1", T.m.t).attr("y2", T.h - T.m.b).style("display", "none");
  const dot = trend.append("circle").attr("class", "dot").attr("r", 4).style("display", "none");
  trend.append("rect").attr("x", T.m.l).attr("y", 0).attr("width", T.w - T.m.l - T.m.r).attr("height", T.h - T.m.b)
    .attr("fill", "transparent")
    .on("mousemove", e => {
      const [mx] = d3.pointer(e);
      const i = Math.max(0, Math.min(N - 1, Math.round(x.invert(mx)) - FIRST_YEAR));
      const v = sel ? sel[i] : nat[i];
      cross.style("display", null).attr("x1", x(FIRST_YEAR + i)).attr("x2", x(FIRST_YEAR + i));
      dot.style("display", v == null ? "none" : null).attr("cx", x(FIRST_YEAR + i)).attr("cy", v == null ? 0 : y(v));
      const rows = [sel ? ["Selected", sel[i]] : null, ["U.S.", nat[i]]].filter(Boolean);
      tipAt(e, `<b>${FIRST_YEAR + i}</b>` + rows.map(([k, r]) => `<div class="row"><span>${k}</span>${r == null ? "–" : fmtRate(r)}</div>`).join(""));
    })
    .on("mouseleave", () => { cross.style("display", "none"); dot.style("display", "none"); hideTip(); });
}

// ---------- interaction ----------

function select(level, id) {
  state.selected = { level, id };
  render();
  if (level === "county") showCountyDetail(id, nameOf("county", id));
  else hideCountyDetail();
}

function tipAt(e, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const r = tooltip.getBoundingClientRect();
  const x = e.clientX + 14 + r.width > innerWidth ? e.clientX - r.width - 14 : e.clientX + 14;
  const y = Math.min(e.clientY + 14, innerHeight - r.height - 4);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function showTip(e, level, id) {
  const u = values.get(id);
  const nYears = +ui.y1.value - +ui.y0.value + 1;
  const rows = u ? [
    [`${MEASURE_LABEL[ui.measure.value]} (${ui.y0.value}–${ui.y1.value})`, fmtInt(u.E)],
    ["Avg. population", d3.format(",.0f")(u.P / nYears)],
    ["Rate per 100k / yr", fmtRate(u.rate)],
    ["Smoothed rate", fmtRate(u.smoothed)],
  ] : [["No population data", ""]];
  tipAt(e, `<b>${nameOf(level, id)}</b>` + rows.map(([k, v]) => `<div class="row"><span>${k}</span>${v}</div>`).join(""));
}

function hideTip() { tooltip.hidden = true; }

function reset() {
  state.selected = null;
  state.focusState = null;
  svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
  hideCountyDetail();
  render();
}

// ---------- init ----------

Promise.all([
  d3.csv("data/county_year.csv"),
  d3.csv("data/state_year.csv"),
  d3.json("https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-albers-10m.json"),
]).then(([countyRows, stateRows, us]) => {
  data = { county: index(countyRows, "fips"), state: index(stateRows, "state") };
  nationalSeries = series();
  for (const s of data.state.values()) {
    for (let i = 0; i < N; i++) {
      nationalSeries.crashes[i] += s.crashes[i];
      nationalSeries.fatals[i] += s.fatals[i];
      nationalSeries.pop[i] += s.pop[i];
    }
  }

  for (const sel of [ui.y0, ui.y1]) {
    sel.innerHTML = d3.range(FIRST_YEAR, LAST_YEAR + 1).map(y => `<option>${y}</option>`).join("");
  }
  ui.y0.value = 2020;
  ui.y1.value = LAST_YEAR;

  drawMap(us);
  render();

  ui.level.addEventListener("change", () => { state.focusState = null; render(); });
  for (const el of [ui.measure, ui.norm]) el.addEventListener("change", render);
  ui.y0.addEventListener("change", () => { if (+ui.y0.value > +ui.y1.value) ui.y1.value = ui.y0.value; render(); });
  ui.y1.addEventListener("change", () => { if (+ui.y1.value < +ui.y0.value) ui.y0.value = ui.y1.value; render(); });
  $("reset").addEventListener("click", reset);
  darkQuery.addEventListener("change", render);
});
