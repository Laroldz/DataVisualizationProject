const FIRST_YEAR = 1975, LAST_YEAR = 2024, N = LAST_YEAR - FIRST_YEAR + 1;
// Plasma, trimmed at both ends and reversed: low values are pale yellow on the light page,
// high ones deep purple.
const RAMP_LIGHT = d3.quantize(d3.interpolatePlasma, 9).slice(1, 8).reverse();
const RAMP_DARK = RAMP_LIGHT; // the page has a single light theme

const fmtInt = d3.format(",");
const fmtRate = d3.format(",.1f");
const NORM_LABEL = {
  smoothed: "Smoothed rate per 100k / yr", rate: "Rate per 100k / yr", count: "Total",
  share: "Share matching the filters (smoothed %)",
};
const MEASURE_LABEL = { fatals: "fatalities", crashes: "fatal crashes" };

const $ = id => document.getElementById(id);
const ui = { level: $("level"), measure: $("measure"), norm: $("norm"), y0: $("y0"), y1: $("y1") };
const tooltip = $("tooltip");
const darkQuery = { matches: false, addEventListener() {} }; // always light; kept so views can stay theme-aware

const state = { selected: null, focusState: null }; // selected = {level, id}
// base = all crashes; cur = crashes matching the active filters (=== base when none are active).
// Each is { county: Map, state: Map, national: series }.
let base, cur, counties, states, nameOf, values;

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

// Empirical Bayes (Marshall 1991, method of moments): shrink each unit's rate E/D toward
// its group's rate, by an amount that grows as the unit's denominator D shrinks.
function smooth(units, scale) {
  const E = d3.sum(units, u => u.E), D = d3.sum(units, u => u.D);
  if (!D) return;
  const m = E / D;
  const s2 = d3.sum(units, u => u.D * (u.E / u.D - m) ** 2) / D;
  const A = Math.max(0, s2 - m / (D / units.length));
  for (const u of units) {
    const w = A + m / u.D > 0 ? A / (A + m / u.D) : 1;
    u.smoothed = (m + w * (u.E / u.D - m)) * scale;
  }
}

function compute(level = ui.level.value) {
  const measure = ui.measure.value, norm = ui.norm.value;
  const i0 = +ui.y0.value - FIRST_YEAR, i1 = +ui.y1.value - FIRST_YEAR;
  const source = cur[level], all = base[level];
  const out = new Map();
  for (const [id, s] of source) {
    const P = sum(s.pop, i0, i1);
    if (!P) continue;
    const E = sum(s[measure], i0, i1);
    const a = all.get(id), total = a ? sum(a[measure], i0, i1) : 0;
    if (norm === "share" && !total) continue;
    // Share mode smooths the share of all crashes; otherwise the rate per resident.
    out.set(id, { id, E, P, total, D: norm === "share" ? total : P, rate: E / P * 1e5, share: total ? E / total * 100 : null });
  }
  // County rates shrink toward their state; state rates shrink toward the nation.
  const groups = d3.group(out.values(), u => level === "county" ? Math.floor(u.id / 1000) : 0);
  for (const g of groups.values()) smooth(g, norm === "share" ? 100 : 1e5);
  for (const u of out.values()) u.value = norm === "count" ? u.E : norm === "rate" ? u.rate : u.smoothed;
  return out;
}

// Per-area, per-year counts for crashes matching the active filters, from the crash table.
function aggregate(t) {
  const fresh = s => ({ crashes: new Float64Array(N), fatals: new Float64Array(N), pop: s?.pop ?? new Float64Array(N) });
  const county = new Map([...base.county].map(([id, s]) => [id, fresh(s)]));
  const st = new Map([...base.state].map(([id, s]) => [id, fresh(s)]));
  const fips = filters.meta.fips, match = filters.match;
  for (let i = 0; i < t.cats.length; i++) {
    if (!match(t.cats[i], t.flags[i], t.hour[i], t.dow[i])) continue;
    const id = fips[t.county[i]], y = t.year[i], f = t.fatals[i];
    if (!county.has(id)) county.set(id, fresh());
    const c = county.get(id); c.crashes[y]++; c.fatals[y] += f;
    const sid = Math.floor(id / 1000);
    if (!st.has(sid)) st.set(sid, fresh());
    const s = st.get(sid); s.crashes[y]++; s.fatals[y] += f;
  }
  return { county, state: st, national: nationalOf(st) };
}

function nationalOf(stateMap) {
  const nat = series();
  for (const s of stateMap.values()) {
    for (let i = 0; i < N; i++) {
      nat.crashes[i] += s.crashes[i];
      nat.fatals[i] += s.fatals[i];
      nat.pop[i] += s.pop[i];
    }
  }
  return nat;
}

async function applyFilters() {
  const shareOpt = ui.norm.querySelector('option[value="share"]');
  shareOpt.disabled = !filterActive();
  if (!filterActive()) {
    if (ui.norm.value === "share") ui.norm.value = "smoothed";
    cur = base;
    return render();
  }
  if (!filters.table) {
    $("filter-status").textContent = "Loading crash details (one-time, about 8 MB)…";
    await loadCrashTable();
  }
  $("filter-status").textContent = "";
  cur = aggregate(filters.table);
  render();
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
  drawGlance(level);
  drawPanel();
  refreshCountyDetail();
  refreshRoute();
  refreshCompare();
  refreshPolicy();
  refreshPatterns();
  updateFilterHeader(+ui.y0.value, +ui.y1.value);
  const area = level === "county" ? "counties" : "states";
  const toward = level === "county" ? "their state's" : "the national";
  $("note").textContent = (filterActive() ? `Showing only crashes matching: ${filterSummary()}. ` : "") + ({
    smoothed: `Smoothed rates use empirical Bayes: low-population ${area} are pulled toward ${toward} rate, so a single crash can't produce an extreme value.`,
    rate: "Unsmoothed rates: very small counties can show extreme values from just one or two crashes.",
    count: "Raw counts mostly track population. Switch to a rate to compare areas fairly.",
    share: `Percent of all ${ui.measure.value === "fatals" ? "deaths" : "fatal crashes"} that match the filters, smoothed so ${area} with few crashes are pulled toward ${toward} share.`,
  })[norm] + " Colors are quantile bins (each holds ~1/7 of areas).";
}

// ---------- the U.S. at a glance ----------

// National totals for the year range (and filters), plus the top 10 states and counties.
function drawGlance(mapLevel) {
  const measure = ui.measure.value, nat = cur.national;
  const y0 = +ui.y0.value, y1 = +ui.y1.value, nYears = y1 - y0 + 1;
  const i0 = y0 - FIRST_YEAR, i1 = y1 - FIRST_YEAR;
  const E = sum(nat[measure], i0, i1), P = sum(nat.pop, i0, i1);
  const days = d3.sum(d3.range(y0, y1 + 1), y => (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 366 : 365);
  const noun = MEASURE_LABEL[measure], matching = filterActive() ? "Matching " : "";
  const years = y0 === y1 ? `${y0}` : `${y0}–${y1}`;

  // Change against the same number of years just before the range.
  const p0 = i0 - nYears, p1 = i0 - 1;
  const prev = p0 >= 0 ? sum(nat[measure], p0, p1) : null;
  const prevYears = p0 >= 0 ? (nYears === 1 ? `${y0 - 1}` : `${y0 - nYears}–${y0 - 1}`) : "";
  const change = prev ? (E - prev) / prev * 100 : null;

  const yearVals = d3.range(i0, i1 + 1).map(i => [FIRST_YEAR + i, nat[measure][i]]);
  const [peakYear, peak] = d3.greatest(yearVals, d => d[1]);

  const kpis = [
    [`${matching}deaths`, fmtInt(sum(nat.fatals, i0, i1)), years],
    [`${matching}fatal crashes`, fmtInt(sum(nat.crashes, i0, i1)), years],
    [`${matching}${noun} per 100k / yr`, P ? fmtRate(E / P * 1e5) : "–", `${d3.format(".3~s")(P / nYears)} residents`],
    [`${matching}${noun} per day`, d3.format(",.0f")(E / days), "on average"],
    [`Change vs ${prevYears || "previous years"}`,
      change == null ? "–" : `${change > 0 ? "▲" : change < 0 ? "▼" : ""} ${d3.format("+.1f")(change)}%`,
      change == null ? "no earlier data" : `${fmtInt(prev)} before`, change > 0 ? "up" : change < 0 ? "down" : ""],
    [`Deadliest year in range`, `${peakYear}`, `${fmtInt(peak)} ${noun}`],
  ];
  $("glance-sub").textContent = `${matching ? `Crashes matching: ${filterSummary()}. ` : ""}${years}, all states and counties.`;
  $("kpis").innerHTML = kpis.map(([k, v, note, cls = ""]) =>
    `<div class="kpi ${cls}"><span>${k[0].toUpperCase() + k.slice(1)}</span><b>${v}</b><small>${note}</small></div>`).join("");

  for (const level of ["state", "county"]) drawRank(level, level === mapLevel ? values : compute(level));
}

function drawRank(level, vals) {
  const norm = ui.norm.value, fmt = norm === "count" ? fmtInt : fmtRate;
  const rows = [...vals.values()].sort((a, b) => b.value - a.value).slice(0, 10);
  const table = d3.select(`#rank-${level}`);
  table.select(".rank-col").text({ count: "Total", share: "Share %" }[norm] ?? "Per 100k");
  const nYears = +ui.y1.value - +ui.y0.value + 1;
  table.select("tbody").selectAll("tr").data(rows).join("tr")
    .on("click", (e, u) => goToPlace({ level, id: u.id }))
    .html((u, i) => `<td>${i + 1}</td><td>${nameOf(level, u.id)}</td><td class="num">${fmt(u.value)}</td><td class="num">${d3.format(".3~s")(u.P / nYears)}</td>`);
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

// ---------- side panel ----------

function selectedSeries(src) {
  const s = state.selected;
  if (!s) return src.national;
  return src[s.level].get(s.id) ?? series();
}

function drawPanel() {
  const measure = ui.measure.value, share = ui.norm.value === "share";
  const i0 = +ui.y0.value - FIRST_YEAR, i1 = +ui.y1.value - FIRST_YEAR, nYears = i1 - i0 + 1;
  const s = state.selected;
  const ser = selectedSeries(cur), all = selectedSeries(base);
  const E = sum(ser[measure], i0, i1), P = sum(ser.pop, i0, i1), total = sum(all[measure], i0, i1);
  const nat = cur.national;
  const natRate = sum(nat[measure], i0, i1) / sum(nat.pop, i0, i1) * 1e5;
  const natShare = sum(nat[measure], i0, i1) / sum(base.national[measure], i0, i1) * 100;
  const u = s && s.level === ui.level.value ? values.get(s.id) : null;

  $("sel-title").textContent = s ? nameOf(s.level, s.id) : "United States";
  $("add-compare").textContent = `+ Add ${s ? nameOf(s.level, s.id) : "United States"} to compare`;
  const stats = [
    [`${filterActive() ? "Matching" : "Total"} ${MEASURE_LABEL[measure]}, ${ui.y0.value}–${ui.y1.value}`, fmtInt(E)],
    filterActive() ? ["Share of all", total ? `${fmtRate(E / total * 100)}%` : "–"] : ["Avg. population", d3.format(",.0f")(P / nYears)],
    ["Rate per 100k / yr", P ? fmtRate(E / P * 1e5) : "–"],
    s ? [share ? "Smoothed share" : "Smoothed rate", u?.smoothed != null ? fmtRate(u.smoothed) + (share ? "%" : "") : "–"] : null,
    s ? (share ? ["U.S. share", `${fmtRate(natShare)}%`] : ["U.S. rate", fmtRate(natRate)]) : null,
  ].filter(Boolean);
  // National numbers live in the "at a glance" section; here they'd only repeat it.
  $("sel-stats").innerHTML = s
    ? stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")
    : `<p class="panel-hint">Click a state or county to see its numbers. National totals are in section 1.</p>`;
  drawTrend(s ? [ser, all] : null, measure, share);
}

const trend = d3.select("#trend");
const T = { w: 360, h: 200, m: { t: 10, r: 70, b: 22, l: 32 } };

function drawTrend(selected, measure, share) {
  // Per-year rate per 100k, or (share mode) percent of all crashes that match the filters.
  const valueAt = ([s, all], i) => share
    ? (all[measure][i] ? s[measure][i] / all[measure][i] * 100 : null)
    : (s.pop[i] ? s[measure][i] / s.pop[i] * 1e5 : null);
  const years = d3.range(N);
  const nat = years.map(i => valueAt([cur.national, base.national], i));
  const sel = selected ? years.map(i => valueAt(selected, i)) : null;

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
  trend.append("text").attr("x", T.m.l).attr("y", T.m.t - 2)
    .text(share ? `% of ${MEASURE_LABEL[measure]} matching the filters` : `${filterActive() ? "matching " : ""}${MEASURE_LABEL[measure]} per 100k / yr`);

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

  // State law changes for the selected state (or the selected county's state), as markers on the
  // x axis; clicking one opens the before/after view.
  const s = state.selected;
  if (!s) return;
  const st = s.level === "state" ? s.id : Math.floor(s.id / 1000);
  const place = s.level === "state" ? { type: "state", state: st } : { type: "county", fips: s.id };
  const laws = policyData.map((e, i) => [e, i]).filter(([e]) => e.state === st);
  trend.append("g").selectAll("path").data(laws).join("path")
    .attr("class", "law")
    .attr("d", ([e]) => `M${x(e.year)},${T.h - T.m.b - 1}l-4,-7h8z`)
    .on("mousemove", (ev, [e]) => tipAt(ev, `<b>~${e.year}: ${e.label}</b><div class="row"><span>${e.detail}</span></div><div class="row"><span>Click for before / after</span></div>`))
    .on("mouseleave", hideTip)
    .on("click", (ev, [, i]) => { hideTip(); openPolicy(place, i); });
}

// ---------- interaction ----------

function select(level, id, scroll = true) {
  state.selected = { level, id };
  render();
  if (level === "county") {
    $("road-search").value = nameOf("county", id);
    $("road-search").classList.remove("nomatch");
    showCountyDetail(id, nameOf("county", id), scroll);
  }
  else hideCountyDetail();
}

// ---------- search ----------

let places; // label -> { level, id }

function initSearch() {
  places = new Map([
    ...states.map(f => [`${f.properties.name} (state)`, { level: "state", id: +f.id }]),
    ...counties.map(f => [nameOf("county", +f.id), { level: "county", id: +f.id }]),
  ]);
  const labels = [...places.keys()].sort();
  $("places").innerHTML = labels.map(l => `<option value="${l}">`).join("");
  $("county-places").innerHTML = labels.filter(l => places.get(l).level === "county").map(l => `<option value="${l}">`).join("");
  bindSearch($("search"), null, place => goToPlace(place));
  // Section 3's search only knows counties, and opens the road view where you are.
  bindSearch($("road-search"), "county", place => goToPlace(place, $("detail")));
}

function bindSearch(input, level, go) {
  // Picking a suggestion fills in an exact label; Enter also accepts partial text.
  input.addEventListener("input", () => {
    input.classList.remove("nomatch");
    const p = places.get(input.value);
    if (p && (!level || p.level === level)) go(p);
  });
  input.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const hit = findPlace(input.value, level);
    if (!hit) return input.classList.add("nomatch");
    input.value = hit[0];
    go(hit[1]);
  });
}

function findPlace(text, level = null) {
  const q = text.trim().toLowerCase();
  if (!q) return null;
  // Exact, then prefix, then substring matches; ties go to the most populous place.
  const pop = ({ level, id }) => base[level].get(id)?.pop[N - 1] ?? 0;
  const pool = [...places].filter(([, p]) => !level || p.level === level);
  for (const test of [l => l === q, l => l.startsWith(q), l => l.includes(q)]) {
    const hits = pool.filter(([l]) => test(l.toLowerCase()));
    if (hits.length) return d3.greatest(hits, ([, p]) => pop(p));
  }
  return null;
}

function goToPlace({ level, id }, scrollTo = $("g-map")) {
  const feature = (level === "state" ? states : counties).find(f => +f.id === id);
  // Like clicking: a state drills down to its counties; a county is selected in place.
  ui.level.value = "county";
  state.focusState = level === "state" ? id : Math.floor(id / 1000);
  select(level, id, false);
  zoomTo(feature);
  reveal(scrollTo);
}

// ---------- collapsible sections ----------

const COLLAPSED_KEY = "collapsed-groups";

// Each page group's header toggles it; the open/closed state is remembered in this browser.
function initCollapsible() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []; } catch {}
  for (const group of document.querySelectorAll(".group")) {
    const head = group.querySelector(".group-head");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "collapse-btn";
    btn.setAttribute("aria-label", `Collapse or expand: ${head.querySelector("h2").textContent}`);
    head.append(btn);
    head.addEventListener("click", e => {
      if (e.target.closest("a, input, select")) return;
      setCollapsed(group, !group.classList.contains("collapsed"));
    });
    setCollapsed(group, saved.includes(group.id), false);
  }
  // Nav links open their section before the browser jumps to it.
  for (const a of document.querySelectorAll(".navlinks a")) {
    a.addEventListener("click", () => setCollapsed($(a.hash.slice(1)), false));
  }
}

function setCollapsed(group, collapsed, save = true) {
  group.classList.toggle("collapsed", collapsed);
  group.querySelector(".collapse-btn").setAttribute("aria-expanded", String(!collapsed));
  if (!collapsed) {
    // Leaflet maps measure their container, so re-measure once visible again.
    if (typeof detail !== "undefined") detail.map?.invalidateSize();
    if (typeof route !== "undefined") route.map?.invalidateSize();
  }
  if (!save) return;
  const ids = [...document.querySelectorAll(".group.collapsed")].map(g => g.id);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(ids)); } catch {}
}

// Open the section holding `el` (if collapsed), then optionally scroll to `el`.
function reveal(el, scroll = true, block = "start") {
  const group = el.closest(".group");
  if (group?.classList.contains("collapsed")) setCollapsed(group, false);
  if (scroll) el.scrollIntoView({ behavior: "smooth", block });
}

initCollapsible();

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
  const share = ui.norm.value === "share";
  const rows = u ? [
    [`${filterActive() ? "Matching " : ""}${MEASURE_LABEL[ui.measure.value]} (${ui.y0.value}–${ui.y1.value})`, fmtInt(u.E)],
    filterActive() ? ["Share of all", u.share != null ? `${fmtRate(u.share)}%` : "–"] : null,
    ["Avg. population", d3.format(",.0f")(u.P / nYears)],
    ["Rate per 100k / yr", fmtRate(u.rate)],
    [share ? "Smoothed share" : "Smoothed rate", fmtRate(u.smoothed) + (share ? "%" : "")],
  ].filter(Boolean) : [["No data", ""]];
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
  d3.json("data/crash_table.json"),
  d3.json("data/policies.json").catch(() => []),
]).then(([countyRows, stateRows, us, tableMeta, policies]) => {
  policyData = policies;
  const stateMap = index(stateRows, "state");
  base = cur = { county: index(countyRows, "fips"), state: stateMap, national: nationalOf(stateMap) };
  initFilters(tableMeta, applyFilters);
  ui.norm.querySelector('option[value="share"]').disabled = true;

  for (const sel of [ui.y0, ui.y1]) {
    sel.innerHTML = d3.range(FIRST_YEAR, LAST_YEAR + 1).map(y => `<option>${y}</option>`).join("");
  }
  ui.y0.value = 2020;
  ui.y1.value = LAST_YEAR;

  drawMap(us);
  render();
  initSearch();
  initCompare();
  initPolicy();
  initPatterns();

  ui.level.addEventListener("change", () => { state.focusState = null; render(); });
  for (const el of [ui.measure, ui.norm]) el.addEventListener("change", render);
  ui.y0.addEventListener("change", () => { if (+ui.y0.value > +ui.y1.value) ui.y1.value = ui.y0.value; render(); });
  ui.y1.addEventListener("change", () => { if (+ui.y1.value < +ui.y0.value) ui.y0.value = ui.y1.value; render(); });
  $("reset").addEventListener("click", reset);
  $("float-filters").addEventListener("click", () => {
    $("filters").open = true;
    reveal($("filters"));
  });
  darkQuery.addEventListener("change", render);
});
