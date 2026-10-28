// Before / after a policy: compare a place's crashes in the years before and after a state law
// (from prep/policies.py) or a custom event, against a comparison group over the same years.
// Uses helpers from main.js, filters.js, county.js and compare.js (updatePlaceForm, itemLabel...).

let policyData = [];     // [{state, year, category, label, detail, source}], set by main.js
const POL_KEY = "policy-custom-events";
const POL_SUGGEST = {    // filter that isolates the crashes a law targets
  helmet: ["motorcycle", "yes"], bac: ["alcohol", "yes"], alcohol_other: ["alcohol", "yes"],
  speed: ["speeding", "yes"], young: ["young_driver", "yes"],
};
const pol = { current: null, request: 0 };

function savedEvents() {
  try { return JSON.parse(localStorage.getItem(POL_KEY)) ?? []; } catch { return []; }
}
function saveEvents(list) {
  try { localStorage.setItem(POL_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

const stateOfPlace = place => place.state ?? Math.floor(place.fips / 1000);

// ---------- form ----------

function updatePolicyEvents(selectValue) {
  const st = +$("pol-state").value;
  const laws = policyData.map((e, i) => [e, i]).filter(([e]) => e.state === st);
  const mine = savedEvents().map((e, i) => [e, i]).filter(([e]) => e.state === st);
  $("pol-event").innerHTML =
    `<optgroup label="State laws (${nameOf("state", st)})">` +
    (laws.length ? laws.map(([e, i]) => `<option value="p:${i}">~${e.year}: ${e.label}</option>`).join("")
                 : `<option disabled>No law changes on record</option>`) + `</optgroup>` +
    (mine.length ? `<optgroup label="Your events">` + mine.map(([e, i]) => `<option value="c:${i}">${eventDate(e)}: ${e.label}</option>`).join("") + `</optgroup>` : "") +
    `<option value="custom">Custom event…</option>`;
  if (selectValue) $("pol-event").value = selectValue;
  updatePolicyCustom();
}

function updatePolicyCustom() {
  const v = $("pol-event").value;
  $("pol-custom").hidden = v !== "custom";
  $("pol-forget").hidden = !v.startsWith("c:");
  $("pol-ctrl").querySelector('option[value="state"]').disabled = $("pol-type").value === "state";
  if ($("pol-type").value === "state") $("pol-ctrl").value = "us";
}

async function updatePolicyForm() {
  await updatePlaceForm("pol");
  updatePolicyEvents();
}

function eventFromForm() {
  const v = $("pol-event").value, st = +$("pol-state").value;
  if (v.startsWith("p:")) return { ...policyData[+v.slice(2)], curated: true };
  if (v.startsWith("c:")) return { ...savedEvents()[+v.slice(2)], curated: false };
  const label = $("pol-clabel").value.trim() || "Custom event";
  const event = { state: st, date: $("pol-cdate").value, label, curated: false };
  const list = savedEvents();
  list.push({ state: event.state, date: event.date, label });
  saveEvents(list);
  updatePolicyEvents(`c:${list.length - 1}`);
  return event;
}

// ---------- analysis ----------

const DAY_MS = 864e5;
const dayNum = (y, m, d) => Date.UTC(y, m - 1, d) / DAY_MS;          // days since 1970-01-01
const fmtDay = n => d3.utcFormat("%b %-d, %Y")(new Date(n * DAY_MS));
const eventDate = e => e.date ?? `${e.year}-07-01`;                  // older saved events had only a year
const eventDay = e => dayNum(...eventDate(e).split("-").map(Number));

// Periods ("bins") around the event, each {label, start, end (exclusive), part}.
// Curated law years are only known to ±1 (see prep/policies.py): calendar years, skipping Y-1 and Y.
// Custom events have an exact date: 12-month periods before and after it, skipping the day itself.
function policyBins(event, n, firstYear) {
  const lo = dayNum(firstYear, 1, 1), hi = dayNum(LAST_YEAR + 1, 1, 1);
  let bins;
  if (event.curated) {
    const Y = event.year;
    bins = d3.range(Y - 1 - n, Y + n + 1).map(y => ({
      label: `${y}`, start: dayNum(y, 1, 1), end: dayNum(y + 1, 1, 1),
      part: y < Y - 1 ? "before" : y > Y ? "after" : "gap",
    }));
  } else {
    const [y, m, d] = eventDate(event).split("-").map(Number);
    const shift = k => dayNum(y + k, m, d);
    bins = [
      ...d3.range(-n, 0).map(k => ({ label: `${k}y`, start: shift(k), end: shift(k + 1), part: "before" })),
      ...d3.range(1, n + 1).map(k => ({ label: `+${k}y`, start: shift(k - 1) + 1, end: shift(k) + 1, part: "after" })),
    ];
  }
  // Keep whole periods only, so before and after compare like with like.
  return bins.filter(b => b.start >= lo && b.end <= hi);
}

// Person-years in [start, end): each calendar year's population times the share of it covered.
function personYears(pop, start, end) {
  let total = 0;
  for (let y = new Date(start * DAY_MS).getUTCFullYear(); dayNum(y, 1, 1) < end; y++) {
    const a = Math.max(start, dayNum(y, 1, 1)), b = Math.min(end, dayNum(y + 1, 1, 1));
    total += pop(y - FIRST_YEAR) * (b - a) / (dayNum(y + 1, 1, 1) - dayNum(y, 1, 1));
  }
  return total;
}

async function runPolicy(place, event) {
  const request = ++pol.request;
  const n = +$("pol-n").value, ctrl = $("pol-ctrl").value, measure = ui.measure.value;
  const bins = policyBins(event, n, place.type === "road" ? POINT_FIRST_YEAR : FIRST_YEAR);
  if (!bins.some(b => b.part === "before") || !bins.some(b => b.part === "after")) {
    $("pol-results").hidden = true;
    return $("pol-status").textContent = `Not enough data before and after ${event.curated ? event.year : fmtDay(eventDay(event))} for this place` +
      (place.type === "road" ? ` (road crashes are located from ${POINT_FIRST_YEAR} on).` : ".");
  }
  if (!filters.table) {
    $("pol-status").textContent = "Loading crash details (one-time, about 11 MB)…";
    await loadCrashTable();
  }
  const st = stateOfPlace(place);
  const placeE = new Float64Array(bins.length), ctrlE = new Float64Array(bins.length);
  const first = bins[0].start, last = bins.at(-1).end;
  const yMin = new Date(first * DAY_MS).getUTCFullYear() - FIRST_YEAR;
  const yMax = new Date((last - 1) * DAY_MS).getUTCFullYear() - FIRST_YEAR;
  const binOf = dn => {
    if (dn < first || dn >= last) return -1;
    for (let b = 0; b < bins.length; b++) if (dn >= bins[b].start && dn < bins[b].end) return b;
    return -1;
  };

  // One pass over the crash table: the place (unless it's a road) and the comparison group.
  const t = filters.table, fips = filters.meta.fips, match = filters.match;
  const inPlace = {
    state: f => Math.floor(f / 1000) === place.state,
    county: f => f === place.fips,
    city: (f, i) => Math.floor(f / 1000) === place.state && t.city[i] === place.code,
    road: () => false,
  }[place.type];
  for (let i = 0; i < t.cats.length; i++) {
    const y = t.year[i];
    if (y < yMin || y > yMax || !t.month[i] || !t.day[i]) continue;
    const f = fips[t.county[i]];
    const here = inPlace(f, i);
    if (!here && ctrl === "state" && Math.floor(f / 1000) !== st) continue;
    const b = binOf(dayNum(FIRST_YEAR + y, t.month[i], t.day[i]));
    if (b < 0 || !match(t.cats[i], t.flags[i], t.hour[i], t.dow[i])) continue;
    (here ? placeE : ctrlE)[b] += measure === "fatals" ? t.fatals[i] : 1;
  }
  if (place.type === "road") {
    // Road crashes come from the county file; they are also in the table, so take them out of the comparison.
    const file = await loadCountyCrashes(place.fips), road = file.roads.indexOf(place.road);
    for (const c of file.crashes) {
      if (c[6] !== road || !crashMatches(c)) continue;
      const b = binOf(dayNum(c[2], c[3], c[10]));
      if (b < 0) continue;
      const v = measure === "fatals" ? c[5] : 1;
      placeE[b] += v; ctrlE[b] -= v;
    }
  }
  if (request !== pol.request) return;

  // Population (states and counties only); the comparison group is the U.S. or state minus the place.
  const popSer = place.type === "state" ? base.state.get(place.state)
    : place.type === "county" ? base.county.get(place.fips) : null;
  const ctrlPopSer = ctrl === "us" ? base.national : base.state.get(st);
  const placePop = popSer && (i => popSer.pop[i]);
  const ctrlPop = popSer && (i => ctrlPopSer.pop[i] - popSer.pop[i]);
  // Denominator: person-years (rate per 100k residents per year) or plain years (events per year).
  const denom = (pop, b) => popSer ? personYears(pop, b.start, b.end) / 1e5 : (b.end - b.start) / 365.25;

  const period = (part, E, pop) => {
    const idx = d3.range(bins.length).filter(i => bins[i].part === part);
    const e = d3.sum(idx, i => E[i]);
    return { events: e, rate: e / d3.sum(idx, i => denom(pop, bins[i])), start: bins[idx[0]].start, end: bins[idx.at(-1)].end };
  };
  const r = {
    place, event, bins, ctrl, measure, perCapita: !!popSer,
    pb: period("before", placeE, placePop), pa: period("after", placeE, placePop),
    cb: period("before", ctrlE, ctrlPop), ca: period("after", ctrlE, ctrlPop),
    series: bins.map((b, i) => ({ ...b, place: placeE[i] / denom(placePop, b), ctrl: ctrlE[i] / denom(ctrlPop, b) })),
  };
  r.placeChange = r.pa.rate / r.pb.rate - 1;
  r.ctrlChange = r.ca.rate / r.cb.rate - 1;
  r.effect = (1 + r.placeChange) / (1 + r.ctrlChange) - 1;
  const counts = [r.pb.events, r.pa.events, r.cb.events, r.ca.events];
  if (counts.every(c => c > 0)) {
    const se = Math.sqrt(d3.sum(counts, c => 1 / c));
    const lr = Math.log(1 + r.effect);
    r.ci = [Math.exp(lr - 1.96 * se) - 1, Math.exp(lr + 1.96 * se) - 1];
  }
  pol.current = { place, event };
  drawPolicy(r);
}

// ---------- drawing ----------

const signed = v => `${v >= 0 ? "+" : "−"}${d3.format(".0f")(Math.abs(v * 100))}%`;

// "1994–1996" for calendar-year periods, "Sep 1, 2013 – Aug 31, 2015" for exact dates.
function periodText(p, curated) {
  if (curated) {
    const a = new Date(p.start * DAY_MS).getUTCFullYear(), b = new Date((p.end - 1) * DAY_MS).getUTCFullYear();
    return a === b ? `${a}` : `${a}–${b}`;
  }
  return `${fmtDay(p.start)} – ${fmtDay(p.end - 1)}`;
}

function drawPolicy(r) {
  const placeName = itemLabel(r.place), ctrlName = r.ctrl === "us" ? "the rest of the U.S." : `the rest of ${nameOf("state", stateOfPlace(r.place))}`;
  const what = r.measure === "fatals" ? "deaths" : "fatal crashes";
  const unit = (r.perCapita ? "per 100k residents" : "per year") + (filterActive() ? ` (filtered: ${filterSummary()})` : "");
  const colors = darkQuery.matches ? CMP_COLORS.dark : CMP_COLORS.light;
  const cur = r.event.curated;
  const when = cur ? `took effect ${r.event.year - 1}–${r.event.year}` : `on ${fmtDay(eventDay(r.event))}`;
  $("pol-status").textContent = "";
  $("pol-results").hidden = false;

  const better = r.effect < 0;
  const chance = !r.ci || (r.ci[0] < 0 && r.ci[1] > 0);
  $("pol-summary").innerHTML =
    `<b>${r.event.label}</b> in ${nameOf("state", r.event.state)} (${when}).<br>` +
    `In ${placeName}, ${what} ${unit} went from ${fmtRate(r.pb.rate)} (${periodText(r.pb, cur)}) to ${fmtRate(r.pa.rate)} (${periodText(r.pa, cur)}), ` +
    `<b>${signed(r.placeChange)}</b>. Over the same ${cur ? "years" : "periods"} ${ctrlName} changed <b>${signed(r.ctrlChange)}</b>.<br>` +
    `Relative to that comparison, ${placeName} did <b>${d3.format(".0f")(Math.abs(r.effect * 100))}% ${better ? "better" : "worse"}</b>` +
    (r.ci ? ` (95% range ${signed(r.ci[0])} to ${signed(r.ci[1])})` : "") + ". " +
    (chance ? `<span class="warn">That difference could easily be chance.</span>` : `That difference is unlikely to be chance alone.`);

  const sugg = POL_SUGGEST[r.event.category];
  const suggOn = sugg && filters.active[sugg[0]] === sugg[1];
  $("pol-suggest").hidden = !sugg || suggOn;
  if (sugg && !suggOn) $("pol-suggest").textContent = `Focus on the crashes this law targets: filter to "${FLAG_LABELS[sugg[0]]}"`;
  $("pol-suggest").dataset.key = sugg?.[0] ?? "";

  // Table
  const row = (name, b, a, ch) => `<tr><th>${name}</th><td>${fmtRate(b.rate)} <small>(${fmtInt(b.events)})</small></td><td>${fmtRate(a.rate)} <small>(${fmtInt(a.events)})</small></td><td><b>${signed(ch)}</b></td></tr>`;
  $("pol-table").innerHTML = `<thead><tr><th></th><th>Before<br><small>${periodText(r.pb, cur)}</small></th><th>After<br><small>${periodText(r.pa, cur)}</small></th><th>Change</th></tr></thead>` +
    `<tbody>${row(placeName, r.pb, r.pa, r.placeChange)}${row(`Comparison: ${ctrlName.replace(/^the /, "")}`, r.cb, r.ca, r.ctrlChange)}</tbody>` +
    `<caption>${what[0].toUpperCase()}${what.slice(1)} ${unit} (total in brackets). ` +
    (cur ? `Skips ${r.event.year - 1}–${r.event.year}, when the law took effect.` : "Skips the event day itself.") + `</caption>`;

  // Chart: one point per period, each line indexed to its own before-period average = 100.
  const W = 640, H = 240, m = { t: 22, r: 12, b: 24, l: 40 };
  const pts = r.series.map(s => ({ ...s, pi: s.place / r.pb.rate * 100, ci: s.ctrl / r.cb.rate * 100 }));
  const x = d3.scalePoint(pts.map(p => p.label), [m.l, W - m.r]).padding(0.5);
  const vals = pts.flatMap(p => [p.pi, p.ci]).filter(Number.isFinite);
  const y = d3.scaleLinear([Math.min(80, d3.min(vals)), Math.max(120, d3.max(vals))], [H - m.b, m.t]).nice();
  const svg = d3.select("#pol-chart").attr("viewBox", `0 0 ${W} ${H}`).html("");
  const step = x.step();
  for (const [part, cls, label] of [["before", "before-band", "Before"], ["gap", "gap-band", "Took effect"], ["after", "after-band", "After"]]) {
    const ps = pts.filter(p => p.part === part);
    if (!ps.length) continue;
    const a = x(ps[0].label) - step / 2, b = x(ps.at(-1).label) + step / 2;
    svg.append("rect").attr("class", cls).attr("x", a).attr("width", b - a).attr("y", m.t).attr("height", H - m.t - m.b);
    svg.append("text").attr("class", "band-label").attr("x", (a + b) / 2).attr("y", m.t - 6).attr("text-anchor", "middle").text(label);
  }
  svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)))
    .call(g => g.select(".domain").remove())
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--grid)"));
  svg.append("line").attr("class", "base100").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(100)).attr("y2", y(100));
  if (!cur) { // exact-date event: a line between the last "before" and the first "after" period
    const lastBefore = pts.filter(p => p.part === "before").at(-1), firstAfter = pts.find(p => p.part === "after");
    const ex = (x(lastBefore.label) + x(firstAfter.label)) / 2;
    svg.append("line").attr("class", "event-line").attr("x1", ex).attr("x2", ex).attr("y1", m.t).attr("y2", H - m.b);
    svg.append("text").attr("class", "band-label").attr("x", ex).attr("y", H - m.b - 6).attr("text-anchor", "middle").text(fmtDay(eventDay(r.event)));
  }
  svg.append("g").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickSizeOuter(0))
    .call(g => g.select(".domain").attr("stroke", "var(--axis)"))
    .call(g => g.selectAll(".tick line").attr("stroke", "var(--axis)"));
  const line = key => d3.line().defined(p => Number.isFinite(p[key])).x(p => x(p.label)).y(p => y(p[key]));
  for (const [key, color] of [["ci", colors[1]], ["pi", colors[0]]]) {
    svg.append("path").attr("fill", "none").attr("stroke", color).attr("stroke-width", 2).attr("d", line(key)(pts));
    svg.selectAll(null).data(pts.filter(p => Number.isFinite(p[key]))).join("circle")
      .attr("cx", p => x(p.label)).attr("cy", p => y(p[key])).attr("r", 3).attr("fill", color);
  }
  const cross = svg.append("line").attr("class", "cross").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", 0).attr("width", W - m.l - m.r).attr("height", H - m.b).attr("fill", "transparent")
    .on("mousemove", e => {
      const mx = d3.pointer(e)[0];
      const p = d3.least(pts, p => Math.abs(x(p.label) - mx));
      cross.style("display", null).attr("x1", x(p.label)).attr("x2", x(p.label));
      tipAt(e, `<b>${cur ? p.label : periodText(p, false)}</b>` +
        `<div class="row"><span><i class="chip" style="background:${colors[0]}"></i>${placeName}</span>${fmtRate(p.pi)} <small>(${fmtRate(p.place)} ${unit})</small></div>` +
        `<div class="row"><span><i class="chip" style="background:${colors[1]}"></i>Comparison</span>${fmtRate(p.ci)} <small>(${fmtRate(p.ctrl)})</small></div>`);
    })
    .on("mouseleave", () => { cross.style("display", "none"); hideTip(); });
  $("pol-legend").innerHTML = `<span class="cmp-key"><i style="background:${colors[0]}"></i>${placeName}</span>` +
    `<span class="cmp-key"><i style="background:${colors[1]}"></i>Comparison: ${ctrlName.replace(/^the /, "")}</span>` +
    `<span class="cmp-key muted">100 = each line's own "before" average${cur ? "" : "; periods are 12 months from the event date"}</span>`;
  $("pol-source").textContent = cur ? `Law date source: ${r.event.source}. ${r.event.detail}.` : "Custom event entered on this page.";
}

// Called from main.js render() so filters and the Measure control apply.
function refreshPolicy() {
  if (pol.current) runPolicy(pol.current.place, pol.current.event);
}

// Open the section for a given place and curated event (from the side-panel trend markers).
async function openPolicy(place, eventIndex) {
  $("pol-type").value = place.type;
  $("pol-state").value = stateOfPlace(place);
  await updatePlaceForm("pol");
  if (place.type === "county") $("pol-county").value = place.fips;
  updatePolicyEvents(`p:${eventIndex}`);
  reveal($("policy"));
  runPolicy(place, { ...policyData[eventIndex], curated: true });
}

function initPolicy() {
  fillSelect("pol-state", stateOptions());
  $("pol-state").value = 48;
  for (const id of ["pol-type", "pol-state", "pol-county"]) $(id).addEventListener("change", updatePolicyForm);
  $("pol-event").addEventListener("change", updatePolicyCustom);
  $("pol-form").addEventListener("submit", e => { e.preventDefault(); runPolicy(placeFromForm("pol"), eventFromForm()); });
  for (const id of ["pol-n", "pol-ctrl"]) $(id).addEventListener("change", refreshPolicy);
  $("pol-forget").addEventListener("click", () => {
    const list = savedEvents();
    list.splice(+$("pol-event").value.slice(2), 1);
    saveEvents(list);
    updatePolicyEvents();
  });
  $("pol-suggest").addEventListener("click", e => {
    const key = e.target.dataset.key, sel = document.querySelector(`#filter-grid select[data-key="${key}"]`);
    if (!sel) return;
    sel.value = POL_SUGGEST[pol.current.event.category][1];
    sel.dispatchEvent(new Event("change"));
  });
  darkQuery.addEventListener("change", refreshPolicy);
  updatePolicyForm();
}
