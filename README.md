# DataVisualizationProject

U.S. Traffic Fatality Explorer: an interactive D3 map of fatal crashes (NHTSA FARS, 1975–2024), normalized by county population (NCI SEER).

## Run the map

```
python -m http.server -d web 8000
```

Then open http://localhost:8000. The aggregated data in `web/data/` is committed, so the raw FARS files aren't needed to view the map.

The page uses one soft light theme and is split into five color-coded groups, linked from the sticky top bar: **1 The United States at a glance** (national totals, change vs the previous period, deadliest year, top 10 states and counties), **2 Explore the map** (level, filters, map), **3 Street level** (county road view, route explorer), **4 When & weather** and **5 Compare & evaluate** (compare, before/after a law). A search box sits above group 1. Measure, Show, the year range and the filters live in a small settings bar that floats at the bottom of the screen and applies to every group. Click a group's header to collapse or expand it; the browser remembers which groups are collapsed, and jumping to a group (nav links, search, clicking a county) opens it.

## Rebuild the data

```
python download.py            # raw FARS files -> FARS_Data/ (~6 GB, gitignored)
python prep/build_data.py     # -> web/data/county_year.csv, state_year.csv, crashes/{fips}.json
```

## County road view

Click a county to open a street map of every fatal crash in it, with a ranked list of its deadliest roads. FARS has crash coordinates from 2001 onward (about 97% of crashes), so this view covers 2001–2024. Road names are normalized so variants group together (`I45`, `IH 45` and `I-45 E` all become `I-45`). Rankings are raw counts, because FARS has no per-road traffic volume.

`build_data.py` downloads the SEER county population file into `prep/raw/` (also gitignored). It reconciles county codes that changed over time, such as Miami-Dade, Broomfield CO, Virginia independent cities, and the NYC and Hawaii groupings SEER used before 2000.

## Route explorer

Enter a start and a destination to see every fatal crash (2001+) within 50, 100 or 200 m of the driving route. The view includes a chart of crashes by mile along the route and a list of the deadliest stretches. Addresses are geocoded with OpenStreetMap Nominatim and routes come from the public OSRM demo server. Both are free, rate-limited services meant for light use, so they're fine for demos but not for heavy traffic. Crash matching runs in the browser against the per-county files in `web/data/crashes/`.

## Compare

Put up to 4 items side by side. Each item is the U.S., a state, a county, a city or a road, with its own year range. "Compare another period" copies an item with the preceding years for before/after checks, and "+ Add … to compare" on the map's side panel adds the selected area. The view shows:

- a summary table, with the change against item A
- deaths or rate by year
- share of crashes by hour
- share of crashes involving each factor (alcohol, speeding, pedestrians, night, weekend…)
- crash-type mix

Factor filters apply here too. Cities use FARS city codes, which are stable across years; names come from the years that include `CITYNAME`. FARS has no city or road population, so cities and roads get counts and shares but no per-100k rate. Road items use the geolocated crashes (2001 on).

## When & weather

For the area selected on the map (or the U.S.), using the year range, Measure and filters:

- **By month:** crashes per day in each month, as an index where 100 is the average day, so short months aren't penalized.
- **By day and hour:** a 7 × 24 heatmap showing each cell's share of the week's crashes.
- **By weather:** for clear, rain, snow/ice and fog/other, the share of crashes, deaths per 100 crashes, and the share at night, speeding-related, alcohol-involved and rollover/fixed-object, plus the peak month. Cells well above the all-weather value are shaded.

The section calculates only while it's on screen.

## Before / after a law

Pick a place (state, county, city or road) and either a state traffic-law change or your own event with an exact date. Custom events compare 12-month periods before and after the date, skipping the day itself, with population prorated by day. The page compares crashes in the N years before and after, alongside the same change in a comparison group (rest of the U.S. or rest of the state). The result is a simple difference-in-differences with a 95% interval from Poisson counts. Laws also show as markers on the side panel's trend chart; clicking one opens this view.

```
python prep/policies.py       # -> web/data/policies.json (downloads the CSPP panel into prep/raw/)
```

- **Source:** state law changes come from the [Correlates of State Policy Project](https://ippsr.msu.edu/public-policy/correlates-state-policy) v2.6 (IPPSR, Michigan State University): 0.08 BAC, first and primary seat-belt laws, universal motorcycle-helmet laws, rural-interstate speed limits, handheld-phone bans, graduated licensing and open-container laws. There are 305 changes, 1982–2015.
- **Timing:** CSPP is yearly and its variables don't share one timing convention. A change first seen in year Y is treated as taking effect in Y−1 or Y, and both years are left out of the before/after windows.
- **Cross-checks:** where CSPP has two variables for the same law, events that disagree are dropped (e.g. Utah's 0.08 BAC).
- **Coverage:** CSPP's traffic variables end around 2010–2016, so newer laws need a custom event. Custom events are saved in your browser only.
- **Not county-level:** there is no national record of county-level road policies; state laws apply to every county in the state.

## Factor filters

The "Filter crashes by factor" panel narrows every view (map, rankings, trend chart, county road view and route explorer) by:

- **Conditions:** weather, lighting, road surface
- **Crash and road:** crash type (head-on, rear-end, angle, sideswipe, pedestrian, bicyclist, rollover, fixed object), road type, rural or urban
- **When:** time of day, weekday or weekend
- **Involved:** alcohol (police-reported drinking driver), speeding-related, pedestrian, bicyclist, motorcycle, large truck, hit-and-run, work zone, driver aged 15–20, driver aged 65+

With a filter active, the map can also show **Share matching filters (%)**: the smoothed percentage of each area's fatal crashes that match the filters (e.g. where alcohol is most often involved).

FARS changed how it records several of these over 1975–2024. `prep/factors.py` maps each era's codes onto one set of categories. For example, weather was renumbered in 2010, speeding moved from driver contributing-factor codes to `SPEEDREL` in 2009, the crash-level drinking-driver count was dropped after 2020, and vehicle body types were recoded in 1982 and 1991. A few factors aren't recorded in early years: road type before 1981, work zone before 1981, large trucks before 1982. The page warns when the selected years include such gaps. All factors are packed into two integers per crash in `web/data/crash_table.bin.gz` (about 2.2 million crashes), which the page loads the first time a filter is used.

## Normalization

- **Rate per 100k / yr**: total events ÷ total person-years in the selected year range.
- **Smoothed rate** (default): empirical Bayes (Marshall 1991). Counties are shrunk toward their state's rate, and states toward the national rate, more strongly the smaller the population. This stops tiny counties with one or two crashes from topping the map.
- Rates are per resident. Rural counties with heavy through-traffic (e.g. I-10 or oilfield counties in West Texas) still rank high, because the people who die there often live elsewhere. Normalizing by vehicle-miles traveled would address that.
