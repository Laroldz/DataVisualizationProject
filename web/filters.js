// Crash-factor filters shared by the national map, county road view and route explorer.
// Decodes the packed fields written by prep/factors.py:
//   cats  — CAT_BITS per categorical field (0 = unknown)
//   flags — 2 bits per flag (0 = not recorded that year, 1 = no, 2 = yes)

const CAT_LABELS = {
  weather: "Weather", light: "Lighting", surface: "Road surface",
  crash_type: "Crash type", road_type: "Road type", area: "Rural / urban",
};
const FLAG_LABELS = {
  alcohol: "Alcohol (drinking driver)", speeding: "Speeding-related",
  pedestrian: "Pedestrian involved", bicyclist: "Bicyclist involved",
  motorcycle: "Motorcycle involved", large_truck: "Large truck involved",
  hit_run: "Hit-and-run", work_zone: "Work zone",
  young_driver: "Driver age 15–20", older_driver: "Driver age 65+",
};
const TIME_OPTIONS = {
  night: ["Night (12–6 am)", h => h < 6],
  morning: ["Morning (6 am–12 pm)", h => h >= 6 && h < 12],
  afternoon: ["Afternoon (12–6 pm)", h => h >= 12 && h < 18],
  evening: ["Evening (6 pm–12 am)", h => h >= 18 && h < 24],
};
const DAY_OPTIONS = {
  weekday: ["Weekday (Mon–Fri)", d => d >= 2 && d <= 6],
  weekend: ["Weekend (Sat–Sun)", d => d === 1 || d === 7],
};

const filters = {
  meta: null, active: {}, table: null, tableLoading: null,
  match: () => true,
};

function catIndex(key) { return Object.keys(filters.meta.categories).indexOf(key); }
function flagIndex(key) { return filters.meta.flags.indexOf(key); }

function catValue(cats, key) {
  return (cats >>> (filters.meta.catBits * catIndex(key))) & ((1 << filters.meta.catBits) - 1);
}
function flagValue(flags, key) {
  return (flags >>> (2 * flagIndex(key))) & 3;
}

function filterActive() { return Object.keys(filters.active).length > 0; }

function compileFilter() {
  const { catBits, categories, flags: flagNames } = filters.meta;
  let catMask = 0, catWant = 0, flagMask = 0, flagWant = 0, hourTest = null, dayTest = null;
  for (const [key, val] of Object.entries(filters.active)) {
    if (key === "time") hourTest = TIME_OPTIONS[val][1];
    else if (key === "day") dayTest = DAY_OPTIONS[val][1];
    else if (key in categories) {
      const shift = catBits * catIndex(key);
      catMask |= ((1 << catBits) - 1) << shift;
      catWant |= +val << shift;
    } else {
      const shift = 2 * flagNames.indexOf(key);
      flagMask |= 3 << shift;
      flagWant |= (val === "yes" ? 2 : 1) << shift;
    }
  }
  filters.match = (cats, flags, hour, dow) =>
    (cats & catMask) === catWant && (flags & flagMask) === flagWant &&
    (!hourTest || (hour < 24 && hourTest(hour))) && (!dayTest || dayTest(dow));
}

function filterSummary() {
  return Object.entries(filters.active).map(([key, val]) => {
    if (key === "time") return TIME_OPTIONS[val][0];
    if (key === "day") return DAY_OPTIONS[val][0];
    if (key in filters.meta.categories) return `${CAT_LABELS[key]}: ${filters.meta.categories[key][val - 1]}`;
    return `${FLAG_LABELS[key]}: ${val === "yes" ? "yes" : "no"}`;
  }).join(" · ");
}

// Active factors that aren't recorded for some years in [y0, y1], e.g. "Large truck involved (not recorded 1975–1981)".
function filterGaps(y0, y1) {
  const gaps = [];
  for (const key of Object.keys(filters.active)) {
    const years = filters.meta.availability[key];
    if (!years) continue;
    const have = new Set(years);
    const missing = d3.range(y0, y1 + 1).filter(y => !have.has(y));
    if (!missing.length) continue;
    const runs = [];
    for (const y of missing) {
      const last = runs.at(-1);
      if (last && last[1] === y - 1) last[1] = y; else runs.push([y, y]);
    }
    const label = CAT_LABELS[key] ?? FLAG_LABELS[key];
    gaps.push(`${label} (not recorded ${runs.map(([a, b]) => a === b ? a : `${a}–${b}`).join(", ")})`);
  }
  return gaps;
}

// Short factor description for a crash tooltip.
function describeCrash(cats, flags) {
  const cat = key => filters.meta.categories[key][catValue(cats, key) - 1];
  const rows = [["Crash type", cat("crash_type")], ["Light", cat("light")], ["Weather", cat("weather")]]
    .filter(([, v]) => v);
  const yes = filters.meta.flags.filter(f => flagValue(flags, f) === 2 && !["pedestrian", "bicyclist"].includes(f))
    .map(f => FLAG_LABELS[f].replace(/ \(.*\)| involved|-related/g, ""));
  if (yes.length) rows.push(["Factors", yes.join(", ")]);
  return rows.map(([k, v]) => `<div class="row"><span>${k}</span>${v}</div>`).join("");
}

// ---------- UI ----------

function initFilters(meta, onChange) {
  filters.meta = meta;
  const groups = [
    ["Conditions", ["weather", "light", "surface"]],
    ["Crash & road", ["crash_type", "road_type", "area"]],
    ["When", ["time", "day"]],
    ["Involved", meta.flags],
  ];
  const root = d3.select("#filter-grid").html("");
  for (const [title, keys] of groups) {
    const g = root.append("fieldset").attr("class", "filter-group");
    g.append("legend").text(title);
    for (const key of keys) {
      let label, options;
      if (key === "time") [label, options] = ["Time of day", Object.entries(TIME_OPTIONS).map(([k, [l]]) => [k, l])];
      else if (key === "day") [label, options] = ["Day of week", Object.entries(DAY_OPTIONS).map(([k, [l]]) => [k, l])];
      else if (key in meta.categories) [label, options] = [CAT_LABELS[key], meta.categories[key].map((l, i) => [i + 1, l])];
      else [label, options] = [FLAG_LABELS[key], [["yes", "Yes"], ["no", "No"]]];
      const lab = g.append("label");
      lab.append("span").text(label);
      lab.append("select").attr("data-key", key)
        .html(`<option value="">Any</option>` + options.map(([v, l]) => `<option value="${v}">${l}</option>`).join(""))
        .on("change", function () {
          if (this.value) filters.active[key] = this.value; else delete filters.active[key];
          d3.select(this).classed("on", !!this.value);
          compileFilter();
          onChange();
        });
    }
  }
  $("filter-clear").addEventListener("click", () => {
    filters.active = {};
    d3.selectAll("#filter-grid select").property("value", "").classed("on", false);
    compileFilter();
    onChange();
  });
}

function updateFilterHeader(y0, y1) {
  const n = Object.keys(filters.active).length;
  $("filter-count").textContent = $("float-filter-count").textContent = n ? `${n} active` : "none";
  $("float-filters").classList.toggle("on", n > 0);
  $("filter-clear").hidden = !n;
  const gaps = filterActive() ? filterGaps(y0, y1) : [];
  $("filter-gaps").textContent = gaps.length
    ? `Heads up: ${gaps.join("; ")}. Those years show no matching crashes under this filter, so rates there drop to zero.`
    : "";
}

// ---------- crash table (loaded the first time a filter is used) ----------

async function loadCrashTable() {
  filters.tableLoading ??= (async () => {
    const res = await fetch("data/crash_table.bin.gz");
    const buf = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const n = filters.meta.rows, t = {};
    let offset = 0;
    for (const [name, type] of filters.meta.columns) {
      const Arr = { u32: Uint32Array, u16: Uint16Array, u8: Uint8Array }[type];
      t[name] = new Arr(buf, offset, n);
      offset += n * Arr.BYTES_PER_ELEMENT;
    }
    filters.table = t;
    return t;
  })();
  return filters.tableLoading;
}
