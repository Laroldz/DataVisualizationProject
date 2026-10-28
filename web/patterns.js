// "When & weather": month-of-year, day x hour and weather comparisons for the place selected on
// the map (or the U.S.), over the year range, with the factor filters and Measure applied.
// Uses helpers from main.js, filters.js and compare.js (itemLabel).

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pat = { visible: false, dirty: true, timer: null };

function patternPlace() {
  const s = state.selected;
  if (!s) return { type: "us" };
  return s.level === "state" ? { type: "state", state: s.id } : { type: "county", fips: s.id };
}

// Called from main.js render(); the work happens only while the section is on screen.
function refreshPatterns() {
  pat.dirty = true;
  if (!pat.visible) return;
  clearTimeout(pat.timer);
  pat.timer = setTimeout(computePatterns, 50);
}

async function computePatterns() {
  if (!filters.table) {
    $("pat-status").textContent = "Loading crash details (one-time, about 11 MB)…";
    await loadCrashTable();
  }
  pat.dirty = false;
  const place = patternPlace(), measure = ui.measure.value;
  const y0 = +ui.y0.value - FIRST_YEAR, y1 = +ui.y1.value - FIRST_YEAR;
  const t = filters.table, fips = filters.meta.fips, match = filters.match;
  const inPlace = {
    us: () => true,
    state: f => Math.floor(f / 1000) === place.state,
    county: f => f === place.fips,
  }[place.type];
  const nW = filters.meta.categories.weather.length;
  const month = new Float64Array(12), heat = Array.from({ length: 7 }, () => new Float64Array(24));
  const W = Array.from({ length: nW + 1 }, () => ({
    events: 0, crashes: 0, deaths: 0, night: 0, hourKnown: 0,
    speed: 0, speedKnown: 0, alc: 0, alcKnown: 0, single: 0, month: new Float64Array(12),
  }));
  let total = 0;
  for (let i = 0; i < t.cats.length; i++) {
    const y = t.year[i];
    if (y < y0 || y > y1 || !inPlace(fips[t.county[i]]) || !match(t.cats[i], t.flags[i], t.hour[i], t.dow[i])) continue;
    const v = measure === "fatals" ? t.fatals[i] : 1, h = t.hour[i], d = t.dow[i], m = t.month[i];
    total += v;
    if (m) month[m - 1] += v;
    if (h < 24 && d) heat[d - 1][h] += v;
    const w = W[catValue(t.cats[i], "weather")];
    w.events += v; w.crashes++; w.deaths += t.fatals[i];
    if (m) w.month[m - 1]++;
    if (h < 24) { w.hourKnown++; if (h < 6) w.night++; }
    const sp = flagValue(t.flags[i], "speeding"), al = flagValue(t.flags[i], "alcohol");
    if (sp) { w.speedKnown++; if (sp === 2) w.speed++; }
    if (al) { w.alcKnown++; if (al === 2) w.alc++; }
    const ct = catValue(t.cats[i], "crash_type");
    if (ct === 8 || ct === 9) w.single++;
  }

  const years = y1 - y0 + 1, what = measure === "fatals" ? "deaths" : "fatal crashes";
  $("pat-title").textContent = `When & weather: ${itemLabel(place)} · ${ui.y0.value}–${ui.y1.value}`;
  $("pat-status").textContent = total
    ? `${fmtInt(total)} ${what}${filterActive() ? `, filtered: ${filterSummary()}` : ""}.`
    : "No crashes match the current place, years and filters.";
  $("pat-results").hidden = !total;
  if (!total) return;
  drawMonths(month, total, what);
  drawHeat(heat, total, what);
  drawWeather(W, years, what);
}

// ---------- by month ----------

function drawMonths(month, total, what) {
  // Crashes per day in each month, as an index of the average day (100), so short months aren't penalized.
  const perDay = total / 365.25;
  const idx = month.map((v, i) => v / MONTH_DAYS[i] / perDay * 100);
  const Wd = 640, H = 220, m = { t: 12, r: 8, b: 24, l: 36 };
  const x = d3.scaleBand(MONTH_NAMES, [m.l, Wd - m.r]).padding(0.25);
  const lo = Math.min(80, d3.min(idx)), hi = Math.max(120, d3.max(idx));
  const y = d3.scaleLinear([lo, hi], [H - m.b, m.t]).nice();
  const svg = d3.select("#pat-month").attr("viewBox", `0 0 ${Wd} ${H}`).html("");
  svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(Wd - m.l - m.r)))
    .call(g => g.select(".domain").remove())
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--grid)"));
  svg.append("g").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickSizeOuter(0))
    .call(g => g.select(".domain").attr("stroke", "var(--axis)"))
    .call(g => g.selectAll(".tick line").remove());
  // Bars grow up or down from the 100 (average day) line.
  svg.selectAll("rect.bar").data(idx).join("rect").attr("class", "bar")
    .attr("x", (v, i) => x(MONTH_NAMES[i])).attr("width", x.bandwidth())
    .attr("y", v => y(Math.max(v, 100))).attr("height", v => Math.abs(y(v) - y(100)))
    .attr("rx", 2).attr("fill", "var(--series-1)");
  svg.append("line").attr("class", "base100").attr("x1", m.l).attr("x2", Wd - m.r).attr("y1", y(100)).attr("y2", y(100));
  svg.selectAll("rect.hit").data(idx).join("rect").attr("class", "hit")
    .attr("x", (v, i) => x(MONTH_NAMES[i]) - x.step() * x.paddingInner() / 2).attr("width", x.step())
    .attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("mousemove", (e, v) => {
      const i = idx.indexOf(v);
      tipAt(e, `<b>${MONTH_NAMES[i]}</b>` +
        `<div class="row"><span>${what[0].toUpperCase() + what.slice(1)}</span>${fmtInt(month[i])} (${d3.format(".1f")(month[i] / total * 100)}%)</div>` +
        `<div class="row"><span>Per day vs average</span>${v >= 100 ? "+" : "−"}${d3.format(".0f")(Math.abs(v - 100))}%</div>`);
    })
    .on("mouseleave", hideTip);
}

// ---------- day x hour ----------

function drawHeat(heat, total, what) {
  const Wd = 640, cell = 22, m = { t: 6, r: 56, b: 24, l: 36 };
  const cw = (Wd - m.l - m.r) / 24, H = m.t + 7 * cell + m.b;
  const share = heat.map(row => [...row].map(v => v / total * 100));
  const max = d3.max(share.flat());
  const ramp = darkQuery.matches ? RAMP_DARK : RAMP_LIGHT;
  const color = d3.scaleQuantize([0, max], ramp);
  const hourFmt = h => d3.timeFormat("%-I %p")(new Date(2000, 0, 1, h));
  const svg = d3.select("#pat-heat").attr("viewBox", `0 0 ${Wd} ${H}`).html("");
  share.forEach((row, d) => {
    svg.append("text").attr("class", "row-label").attr("x", m.l - 6).attr("y", m.t + d * cell + cell / 2).attr("dy", "0.35em")
      .attr("text-anchor", "end").text(DOW_NAMES[d]);
    const dayTotal = d3.sum(heat[d]);
    svg.append("text").attr("class", "row-total").attr("x", Wd - m.r + 8).attr("y", m.t + d * cell + cell / 2).attr("dy", "0.35em")
      .text(`${d3.format(".1f")(dayTotal / total * 100)}%`);
    row.forEach((v, h) => {
      svg.append("rect").attr("x", m.l + h * cw + 1).attr("y", m.t + d * cell + 1).attr("width", cw - 2).attr("height", cell - 2)
        .attr("rx", 2).attr("fill", color(v))
        .on("mousemove", e => tipAt(e, `<b>${DOW_NAMES[d]} ${hourFmt(h)}–${hourFmt((h + 1) % 24)}</b>` +
          `<div class="row"><span>${what[0].toUpperCase() + what.slice(1)}</span>${fmtInt(heat[d][h])}</div>` +
          `<div class="row"><span>Share of all</span>${d3.format(".2f")(v)}%</div>`))
        .on("mouseleave", hideTip);
    });
  });
  svg.append("text").attr("class", "row-total head").attr("x", Wd - m.r + 8).attr("y", m.t + 7 * cell + 16).text("of week");
  const x = d3.scaleLinear([0, 24], [m.l, m.l + 24 * cw]);
  svg.append("g").attr("transform", `translate(0,${m.t + 7 * cell})`)
    .call(d3.axisBottom(x).tickValues([0, 3, 6, 9, 12, 15, 18, 21]).tickFormat(hourFmt).tickSize(4))
    .call(g => g.select(".domain").remove())
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--axis)"));
  // Legend: the color steps with their share ranges.
  const steps = ramp.map((c, i) => [c, color.invertExtent(c)]);
  $("pat-heat-legend").innerHTML = `<span class="title">Share of the week's ${what}</span>` +
    steps.map(([c, [a]], i) => `<span class="bin"><span class="sw" style="background:${c}"></span><span>${i ? d3.format(".2f")(a) + "%" : ""}</span></span>`).join("");
}

// ---------- by weather ----------

function drawWeather(W, years, what) {
  const labels = filters.meta.categories.weather;
  const all = W.slice(1).reduce((a, w) => {
    for (const k of Object.keys(a)) if (k !== "month") a[k] += w[k];
    return a;
  }, { events: 0, crashes: 0, deaths: 0, night: 0, hourKnown: 0, speed: 0, speedKnown: 0, alc: 0, alcKnown: 0, single: 0, month: null });
  const ratio = (a, b) => b ? a / b * 100 : null;
  const cols = [
    ["Deaths per 100 crashes", w => ratio(w.deaths, w.crashes), ".0f"],
    ["At night (12–6 am)", w => ratio(w.night, w.hourKnown), ".0f", "%"],
    ["Speeding-related", w => ratio(w.speed, w.speedKnown), ".0f", "%"],
    ["Alcohol involved", w => ratio(w.alc, w.alcKnown), ".0f", "%"],
    ["Rollover or fixed object", w => ratio(w.single, w.crashes), ".0f", "%"],
  ];
  const peak = w => {
    const perDay = [...w.month].map((v, i) => v / MONTH_DAYS[i]);
    return MONTH_NAMES[perDay.indexOf(d3.max(perDay))];
  };
  const rows = W.slice(1).map((w, i) => ({ w, label: labels[i] })).filter(r => r.w.crashes > 0);
  const maxShare = d3.max(rows, r => r.w.events / all.events);
  const cell = (w, [, f, fmt, unit = ""]) => {
    const v = f(w), base = f(all);
    // Tint cells clearly above the all-weather value (at least 5 points and 15% higher).
    const hi = v != null && base != null && w.crashes >= 30 && v - base >= 5 && v >= base * 1.15;
    return `<td class="${hi ? "hi" : ""}">${v == null ? "–" : d3.format(fmt)(v) + unit}</td>`;
  };
  const body = rows.map(({ w, label }) => {
    const share = w.events / all.events;
    return `<tr><th>${label}</th>` +
      `<td class="share"><span class="sbar"><i style="width:${share / maxShare * 100}%"></i></span>${d3.format(".1f")(share * 100)}%<small>${fmtInt(w.events)}</small></td>` +
      cols.map(c => cell(w, c)).join("") +
      `<td>${w.crashes >= 30 ? peak(w) : "–"}</td></tr>`;
  }).join("");
  const foot = `<tr class="all"><th>All weather</th><td class="share"><span class="sbar blank"></span>100%<small>${fmtInt(all.events)}</small></td>` +
    cols.map(([, f, fmt, unit = ""]) => `<td>${f(all) == null ? "–" : d3.format(fmt)(f(all)) + unit}</td>`).join("") + `<td></td></tr>`;
  $("pat-weather").innerHTML =
    `<thead><tr><th>Weather</th><th>Share of ${what}</th>${cols.map(c => `<th>${c[0]}</th>`).join("")}<th>Peak month</th></tr></thead>` +
    `<tbody>${body}</tbody><tfoot>${foot}</tfoot>`;
  const unknown = W[0].events;
  const weatherFiltered = "weather" in filters.active;
  $("pat-weather-note").textContent =
    (weatherFiltered ? "A weather filter is on, so only that weather is shown. " : "") +
    "Shaded cells are notably higher than for all weather combined. Percentages are of fatal crashes; peak month is adjusted for month length." +
    (unknown ? ` ${fmtInt(unknown)} ${what} with unknown weather are left out.` : "");
}

function initPatterns() {
  new IntersectionObserver(entries => {
    pat.visible = entries.some(e => e.isIntersecting);
    if (pat.visible && pat.dirty) refreshPatterns();
  }, { rootMargin: "200px" }).observe($("patterns"));
  $("to-patterns").addEventListener("click", () => $("patterns").scrollIntoView({ behavior: "smooth", block: "start" }));
  darkQuery.addEventListener("change", refreshPatterns);
}
