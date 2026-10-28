// Compare view: up to 4 places (U.S., state, county, city or road), each with its own years,
// side by side. Respects the factor filters and the Measure control.
// Uses helpers from main.js (ui, base, nameOf, tipAt...), filters.js and county.js.

const CMP_MAX = 4;
// Categorical slots 1-4 from the validated palette; an item keeps its slot until removed.
const CMP_COLORS = { light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"], dark: ["#3987e5", "#d95926", "#199e70", "#c98500"] };
const CMP_TYPES = { us: "United States", state: "State", county: "County", city: "City", road: "Road" };
const CMP_FACTORS = ["alcohol", "speeding", "pedestrian", "bicyclist", "motorcycle", "large_truck",
                     "hit_run", "work_zone", "young_driver", "older_driver"];
const cmp = { items: [], request: 0, stats: [] };

const cmpColor = slot => (darkQuery.matches ? CMP_COLORS.dark : CMP_COLORS.light)[slot];
const pct = d3.format(".1f");

// ---------- form ----------

function stateOptions() {
  return [...base.state.keys()].filter(s => base.state.get(s).pop.some(p => p > 0))
    .map(s => [s, nameOf("state", s)]).sort((a, b) => a[1].localeCompare(b[1]));
}

function fillSelect(id, options, keep = false) {
  const sel = $(id), prev = sel.value;
  sel.innerHTML = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  if (keep && options.some(([v]) => String(v) === prev)) sel.value = prev;
}

// Place pickers shared with policy.js: elements `${p}-type`, `${p}-state`, `${p}-county`,
// `${p}-city`, `${p}-road`, each wrapped in a label with id `${p}-…-l`.
async function updatePlaceForm(p) {
  const type = $(`${p}-type`).value;
  for (const [id, show] of [["state", type !== "us"], ["county", type === "county" || type === "road"],
                            ["city", type === "city"], ["road", type === "road"]]) {
    $(`${p}-${id}-l`).hidden = !show;
  }
  const st = +$(`${p}-state`).value;
  if (type === "county" || type === "road") {
    fillSelect(`${p}-county`, counties.filter(f => Math.floor(+f.id / 1000) === st)
      .map(f => [+f.id, f.properties.name]).sort((a, b) => a[1].localeCompare(b[1])), true);
  }
  if (type === "city") {
    fillSelect(`${p}-city`, filters.meta.cities.filter(c => c[0] === st).sort((a, b) => b[3] - a[3])
      .map(c => [c[1], `${c[2]} (${fmtInt(c[3])} crashes)`]));
  }
  if (type === "road") {
    $(`${p}-road`).innerHTML = "<option>Loading…</option>";
    const fips = +$(`${p}-county`).value;
    const file = await loadCountyCrashes(fips);
    if (+$(`${p}-county`).value !== fips) return;
    const deaths = d3.rollups(file.crashes, v => d3.sum(v, c => c[5]), c => c[6]).sort((a, b) => b[1] - a[1]);
    fillSelect(`${p}-road`, deaths.map(([r, d]) => [file.roads[r], `${file.roads[r]} (${fmtInt(d)} deaths)`]));
  }
}

function placeFromForm(p) {
  const type = $(`${p}-type`).value, state = +$(`${p}-state`).value;
  const item = { type };
  if (type === "state") item.state = state;
  if (type === "county") item.fips = +$(`${p}-county`).value;
  if (type === "city") Object.assign(item, { state, code: +$(`${p}-city`).value });
  if (type === "road") Object.assign(item, { fips: +$(`${p}-county`).value, road: $(`${p}-road`).value });
  return item;
}

async function updateCompareForm() {
  await updatePlaceForm("cmp");
  $("cmp-add").disabled = cmp.items.length >= CMP_MAX;
}

function itemFromForm() {
  const item = { ...placeFromForm("cmp"), y0: +$("cmp-y0").value, y1: +$("cmp-y1").value };
  if (item.y1 < item.y0) [item.y0, item.y1] = [item.y1, item.y0];
  return item;
}

function addCompareItem(item) {
  if (cmp.items.length >= CMP_MAX) return;
  const used = new Set(cmp.items.map(i => i.slot));
  item.slot = d3.range(CMP_MAX).find(s => !used.has(s));
  cmp.items.push(item);
  $("cmp-add").disabled = cmp.items.length >= CMP_MAX;
  refreshCompare();
}

function itemLabel(item) {
  switch (item.type) {
    case "us": return "United States";
    case "state": return nameOf("state", item.state);
    case "county": return `${nameOf("county", item.fips)} (county)`;
    case "city": {
      const c = filters.meta.cities.find(c => c[0] === item.state && c[1] === item.code);
      return `${c ? c[2] : `City ${item.code}`}, ${nameOf("state", item.state)} (city)`;
    }
    case "road": return `${item.road}, ${nameOf("county", item.fips)}`;
  }
}

// ---------- stats ----------

function emptyStats() {
  return {
    crashes: 0, deaths: 0, byYear: { crashes: new Float64Array(N), fatals: new Float64Array(N) },
    flagYes: new Float64Array(CMP_FACTORS.length), flagKnown: new Float64Array(CMP_FACTORS.length),
    night: 0, weekend: 0, hourKnown: 0, dowKnown: 0,
    types: new Float64Array(filters.meta.categories.crash_type.length + 1), hours: new Float64Array(24),
  };
}

function addCrash(s, yearIdx, fatals, cats, flags, hour, dow) {
  s.crashes++; s.deaths += fatals;
  s.byYear.crashes[yearIdx]++; s.byYear.fatals[yearIdx] += fatals;
  for (let k = 0; k < CMP_FACTORS.length; k++) {
    const v = flagValue(flags, CMP_FACTORS[k]);
    if (v) { s.flagKnown[k]++; if (v === 2) s.flagYes[k]++; }
  }
  if (hour < 24) { s.hourKnown++; s.hours[hour]++; if (hour < 6) s.night++; }
  if (dow >= 1 && dow <= 7) { s.dowKnown++; if (dow === 1 || dow === 7) s.weekend++; }
  s.types[catValue(cats, "crash_type")]++;
}

function tableStats(items) {
  const t = filters.table, fips = filters.meta.fips, match = filters.match;
  const tests = items.map(item => {
    const y0 = item.y0 - FIRST_YEAR, y1 = item.y1 - FIRST_YEAR;
    const place = {
      us: () => true,
      state: f => Math.floor(f / 1000) === item.state,
      county: f => f === item.fips,
      city: (f, i) => Math.floor(f / 1000) === item.state && t.city[i] === item.code,
    }[item.type];
    return { y0, y1, place, s: emptyStats() };
  });
  for (let i = 0; i < t.cats.length; i++) {
    const y = t.year[i];
    let f = null, matched = null;
    for (const test of tests) {
      if (y < test.y0 || y > test.y1) continue;
      f ??= fips[t.county[i]];
      if (!test.place(f, i)) continue;
      matched ??= match(t.cats[i], t.flags[i], t.hour[i], t.dow[i]);
      if (matched) addCrash(test.s, y, t.fatals[i], t.cats[i], t.flags[i], t.hour[i], t.dow[i]);
    }
  }
  return tests.map(t => t.s);
}

async function roadStats(item) {
  const file = await loadCountyCrashes(item.fips);
  const road = file.roads.indexOf(item.road), s = emptyStats();
  for (const c of file.crashes) {
    if (c[6] !== road || c[2] < item.y0 || c[2] > item.y1 || !crashMatches(c)) continue;
    addCrash(s, c[2] - FIRST_YEAR, c[5], c[7], c[8], c[4], c[9]);
  }
  return s;
}

function popOf(item) {
  const ser = item.type === "us" ? base.national : item.type === "state" ? base.state.get(item.state)
    : item.type === "county" ? base.county.get(item.fips) : null;
  return ser ? sum(ser.pop, item.y0 - FIRST_YEAR, item.y1 - FIRST_YEAR) : null;
}

// ---------- refresh ----------

async function refreshCompare() {
  if (!base || !cmp.items.length) {
    $("cmp-results").hidden = true;
    $("cmp-status").textContent = cmp.items.length ? "" : "Add two or more places or time periods to compare them.";
    return;
  }
  const request = ++cmp.request;
  if (!filters.table) {
    $("cmp-status").textContent = "Loading crash details (one-time, about 10 MB)…";
    await loadCrashTable();
  }
  for (const item of cmp.items) {
    item.note = item.type === "road" && item.y0 < POINT_FIRST_YEAR
      ? `Road crashes are only located from ${POINT_FIRST_YEAR} on.` : undefined;
  }
  const tableItems = cmp.items.filter(i => i.type !== "road");
  const tStats = tableItems.length ? tableStats(tableItems) : [];
  const stats = await Promise.all(cmp.items.map(async item =>
    item.type === "road" ? roadStats(item) : tStats[tableItems.indexOf(item)]));
  if (request !== cmp.request) return;

  cmp.stats = cmp.items.map((item, i) => {
    const s = stats[i], years = item.y1 - item.y0 + 1, pop = popOf(item);
    return {
      item, s, years, pop, label: itemLabel(item), color: cmpColor(item.slot),
      period: item.y0 === item.y1 ? `${item.y0}` : `${item.y0}–${item.y1}`,
      rate: pop ? (ui.measure.value === "fatals" ? s.deaths : s.crashes) / pop * 1e5 : null,
    };
  });
  $("cmp-status").textContent = filterActive() ? `Filtered: ${filterSummary()}` : "";
  $("cmp-results").hidden = false;
  drawCompareLegend();
  drawCompareTable();
  drawCompareTrend();
  drawGroupedBars("#cmp-factors", [
    ...CMP_FACTORS.map((f, k) => ({ label: FLAG_LABELS[f], value: d => d.s.flagKnown[k] ? d.s.flagYes[k] / d.s.flagKnown[k] * 100 : null })),
    { label: "Night (12–6 am)", value: d => d.s.hourKnown ? d.s.night / d.s.hourKnown * 100 : null },
    { label: "Weekend (Sat–Sun)", value: d => d.s.dowKnown ? d.s.weekend / d.s.dowKnown * 100 : null },
  ]);
  drawGroupedBars("#cmp-types", filters.meta.categories.crash_type.map((label, k) => ({
    label, value: d => d.s.crashes ? d.s.types[k + 1] / d.s.crashes * 100 : null,
  })));
  drawCompareHours();
}

// ---------- drawing ----------

function drawCompareLegend() {
  d3.select("#cmp-legend").selectAll("span").data(cmp.stats).join("span")
    .attr("class", "cmp-key")
    .html(d => `<i style="background:${d.color}"></i>${d.label} <em>${d.period}</em>`);
}

function drawCompareTable() {
  const measure = ui.measure.value;
  const first = cmp.stats[0];
  const delta = (v, a) => v == null || a == null || !a ? "" :
    `<small class="delta">${v >= a ? "+" : "−"}${pct(Math.abs(v / a - 1) * 100)}% vs A</small>`;
  const perYear = d => (measure === "fatals" ? d.s.deaths : d.s.crashes) / d.years;
  const rows = [
    ["Fatal crashes", d => fmtInt(d.s.crashes)],
    ["Deaths", d => fmtInt(d.s.deaths)],
    [`${MEASURE_LABEL[measure][0].toUpperCase()}${MEASURE_LABEL[measure].slice(1)} per year`,
      d => fmtRate(perYear(d)) + (d === first ? "" : delta(perYear(d), perYear(first)))],
    [`Rate per 100k / yr`, d => d.rate == null ? `<span class="muted">no population</span>`
      : fmtRate(d.rate) + (d === first ? "" : delta(d.rate, first.rate))],
    ["Deaths per crash", d => d.s.crashes ? d3.format(".2f")(d.s.deaths / d.s.crashes) : "–"],
  ];
  const letter = i => "ABCD"[i];
  const head = `<tr><th></th>${cmp.stats.map((d, i) => `
    <th>
      <div class="cmp-head"><i style="background:${d.color}"></i><b>${letter(i)}</b> ${d.label}</div>
      <div class="cmp-years">
        <select data-i="${i}" data-k="y0">${yearOptions(d.item.y0)}</select>–<select data-i="${i}" data-k="y1">${yearOptions(d.item.y1)}</select>
      </div>
      <div class="cmp-actions">
        <button type="button" data-act="period" data-i="${i}" ${cmp.items.length >= CMP_MAX ? "disabled" : ""}>Compare another period</button>
        <button type="button" data-act="remove" data-i="${i}" aria-label="Remove">Remove</button>
      </div>
      ${d.s.crashes < 30 ? `<div class="warn">Small sample (${d.s.crashes} crashes)</div>` : ""}
      ${d.item.note ? `<div class="warn">${d.item.note}</div>` : ""}
    </th>`).join("")}</tr>`;
  const body = rows.map(([k, f]) => `<tr><th>${k}</th>${cmp.stats.map(d => `<td>${f(d)}</td>`).join("")}</tr>`).join("");
  $("cmp-table").innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
}

function yearOptions(sel) {
  return d3.range(FIRST_YEAR, LAST_YEAR + 1).map(y => `<option${y === sel ? " selected" : ""}>${y}</option>`).join("");
}

const CW = 640;

function drawCompareTrend() {
  const measure = ui.measure.value;
  const allPop = cmp.stats.every(d => d.pop);
  const modeSel = $("cmp-trend-mode");
  modeSel.querySelector('option[value="rate"]').disabled = !allPop;
  if (!allPop) modeSel.value = "count";
  const rate = modeSel.value === "rate";
  const ser = d => d3.range(d.item.y0, d.item.y1 + 1).map(y => {
    const i = y - FIRST_YEAR, ev = d.s.byYear[measure][i];
    if (!rate) return [y, ev];
    const p = popOf({ ...d.item, y0: y, y1: y });
    return [y, p ? ev / p * 1e5 : null];
  });
  const lines = cmp.stats.map(d => ({ d, pts: ser(d) }));
  const y0 = d3.min(cmp.items, i => i.y0), y1 = d3.max(cmp.items, i => i.y1);
  const H = 220, m = { t: 16, r: 12, b: 24, l: 44 };
  const x = d3.scaleLinear([y0, Math.max(y1, y0 + 1)], [m.l, CW - m.r]);
  const y = d3.scaleLinear([0, d3.max(lines, l => d3.max(l.pts, p => p[1])) || 1], [H - m.b, m.t]).nice();
  const svg = d3.select("#cmp-trend").attr("viewBox", `0 0 ${CW} ${H}`).html("");
  svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(-(CW - m.l - m.r)).tickFormat(rate ? d3.format(",.1f") : d3.format(",~s")))
    .call(g => g.select(".domain").remove())
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--grid)"));
  svg.append("g").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(Math.min(10, y1 - y0 + 1)).tickFormat(d3.format("d")).tickSizeOuter(0))
    .call(g => g.select(".domain").attr("stroke", "var(--axis)"))
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--axis)"));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10)
    .text(rate ? `${MEASURE_LABEL[measure]} per 100k residents` : `${MEASURE_LABEL[measure]} per year`);
  const line = d3.line().defined(p => p[1] != null).x(p => x(p[0])).y(p => y(p[1]));
  for (const { d, pts } of lines) {
    svg.append("path").attr("fill", "none").attr("stroke", d.color).attr("stroke-width", 2).attr("d", line(pts));
    if (pts.length === 1) svg.append("circle").attr("cx", x(pts[0][0])).attr("cy", y(pts[0][1])).attr("r", 4).attr("fill", d.color);
  }
  const cross = svg.append("line").attr("class", "cross").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", 0).attr("width", CW - m.l - m.r).attr("height", H - m.b).attr("fill", "transparent")
    .on("mousemove", e => {
      const yr = Math.round(x.invert(d3.pointer(e)[0]));
      cross.style("display", null).attr("x1", x(yr)).attr("x2", x(yr));
      const rows = lines.map(({ d, pts }) => [d, pts.find(p => p[0] === yr)?.[1]]).filter(([, v]) => v != null);
      tipAt(e, `<b>${yr}</b>` + (rows.length ? rows.map(([d, v]) =>
        `<div class="row"><span><i class="chip" style="background:${d.color}"></i>${d.label}</span>${rate ? fmtRate(v) : fmtInt(v)}</div>`).join("")
        : `<div class="row"><span>No item covers this year</span></div>`));
    })
    .on("mouseleave", () => { cross.style("display", "none"); hideTip(); });
}

// Horizontal grouped bars: one group per row, one bar per compared item.
function drawGroupedBars(sel, rows) {
  const n = cmp.stats.length, barH = 8, gap = 2, groupGap = 12, m = { t: 4, r: 44, b: 22, l: 170 };
  const groupH = n * barH + (n - 1) * gap;
  const H = m.t + rows.length * (groupH + groupGap) + m.b;
  const vals = rows.flatMap(r => cmp.stats.map(d => r.value(d))).filter(v => v != null);
  const x = d3.scaleLinear([0, Math.max(5, d3.max(vals) ?? 0)], [m.l, CW - m.r]).nice();
  const svg = d3.select(sel).attr("viewBox", `0 0 ${CW} ${H}`).html("");
  svg.append("g").attr("class", "grid").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(v => `${v}%`).tickSize(-(H - m.t - m.b)))
    .call(g => g.select(".domain").remove())
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--grid)"));
  rows.forEach((r, gi) => {
    const gy = m.t + gi * (groupH + groupGap);
    svg.append("text").attr("class", "row-label").attr("x", m.l - 8).attr("y", gy + groupH / 2).attr("dy", "0.35em")
      .attr("text-anchor", "end").text(r.label);
    cmp.stats.forEach((d, i) => {
      const v = r.value(d), by = gy + i * (barH + gap);
      const show = e => tipAt(e, `<b>${r.label}</b><div class="row"><span><i class="chip" style="background:${d.color}"></i>${d.label} (${d.period})</span>${v == null ? "not recorded" : pct(v) + "%"}</div>`);
      if (v == null) {
        svg.append("text").attr("class", "na").attr("x", m.l + 4).attr("y", by + barH / 2).attr("dy", "0.35em").text("not recorded");
      } else {
        svg.append("rect").attr("x", m.l).attr("y", by).attr("height", barH)
          .attr("width", Math.max(0, x(v) - m.l)).attr("rx", 2).attr("fill", d.color);
      }
      // Hit target spans the whole row slot, larger than the bar.
      svg.append("rect").attr("x", 0).attr("y", by - gap / 2).attr("width", CW).attr("height", barH + gap)
        .attr("fill", "transparent").on("mousemove", show).on("mouseleave", hideTip);
    });
  });
}

function drawCompareHours() {
  const H = 200, m = { t: 16, r: 12, b: 24, l: 44 };
  const series = cmp.stats.map(d => ({ d, pts: d3.range(24).map(h => [h, d.s.hourKnown ? d.s.hours[h] / d.s.hourKnown * 100 : null]) }));
  const x = d3.scaleLinear([0, 23], [m.l, CW - m.r]);
  const y = d3.scaleLinear([0, d3.max(series, s => d3.max(s.pts, p => p[1])) || 1], [H - m.b, m.t]).nice();
  const hourFmt = h => d3.timeFormat("%-I %p")(new Date(2000, 0, 1, h));
  const svg = d3.select("#cmp-hours").attr("viewBox", `0 0 ${CW} ${H}`).html("");
  svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(v => `${v}%`).tickSize(-(CW - m.l - m.r)))
    .call(g => g.select(".domain").remove())
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--grid)"));
  svg.append("g").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickValues([0, 3, 6, 9, 12, 15, 18, 21]).tickFormat(hourFmt).tickSizeOuter(0))
    .call(g => g.select(".domain").attr("stroke", "var(--axis)"))
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--axis)"));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("% of each item's fatal crashes, by hour");
  const line = d3.line().defined(p => p[1] != null).x(p => x(p[0])).y(p => y(p[1]));
  for (const { d, pts } of series) svg.append("path").attr("fill", "none").attr("stroke", d.color).attr("stroke-width", 2).attr("d", line(pts));
  const cross = svg.append("line").attr("class", "cross").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", 0).attr("width", CW - m.l - m.r).attr("height", H - m.b).attr("fill", "transparent")
    .on("mousemove", e => {
      const h = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(e)[0]))));
      cross.style("display", null).attr("x1", x(h)).attr("x2", x(h));
      tipAt(e, `<b>${hourFmt(h)}–${hourFmt((h + 1) % 24)}</b>` + series.map(({ d, pts }) =>
        `<div class="row"><span><i class="chip" style="background:${d.color}"></i>${d.label}</span>${pts[h][1] == null ? "–" : pct(pts[h][1]) + "%"}</div>`).join(""));
    })
    .on("mouseleave", () => { cross.style("display", "none"); hideTip(); });
}

// ---------- wiring ----------

function initCompare() {
  fillSelect("cmp-state", stateOptions());
  $("cmp-state").value = 48; // Texas, a useful default for the demo
  for (const id of ["cmp-y0", "cmp-y1"]) $(id).innerHTML = yearOptions(id === "cmp-y0" ? +ui.y0.value : +ui.y1.value);
  for (const id of ["cmp-type", "cmp-state", "cmp-county"]) $(id).addEventListener("change", updateCompareForm);
  $("cmp-form").addEventListener("submit", e => { e.preventDefault(); addCompareItem(itemFromForm()); });
  $("cmp-trend-mode").addEventListener("change", drawCompareTrend);
  $("cmp-table").addEventListener("change", e => {
    const { i, k } = e.target.dataset;
    if (i == null) return;
    const item = cmp.items[+i];
    item[k] = +e.target.value;
    if (item.y1 < item.y0) [item.y0, item.y1] = [item.y1, item.y0];
    refreshCompare();
  });
  $("cmp-table").addEventListener("click", e => {
    const { act, i } = e.target.dataset;
    if (act === "remove") cmp.items.splice(+i, 1);
    else if (act === "period") {
      // Same place, same-length period just before the original (or just after if none is earlier).
      const src = cmp.items[+i], span = src.y1 - src.y0;
      let y1 = src.y0 - 1, y0 = y1 - span;
      if (y1 < FIRST_YEAR) { y0 = Math.min(LAST_YEAR, src.y1 + 1); y1 = Math.min(LAST_YEAR, y0 + span); }
      addCompareItem({ ...src, slot: undefined, y0: Math.max(FIRST_YEAR, y0), y1 });
      return;
    } else return;
    $("cmp-add").disabled = cmp.items.length >= CMP_MAX;
    refreshCompare();
  });
  $("to-compare").addEventListener("click", () => $("compare").scrollIntoView({ behavior: "smooth", block: "start" }));
  $("add-compare").addEventListener("click", () => {
    const s = state.selected;
    const item = !s ? { type: "us" } : s.level === "state" ? { type: "state", state: s.id } : { type: "county", fips: s.id };
    addCompareItem({ ...item, y0: +ui.y0.value, y1: +ui.y1.value });
    $("compare").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  darkQuery.addEventListener("change", refreshCompare);
  updateCompareForm();
  refreshCompare();
}
