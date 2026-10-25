# DataVisualizationProject

U.S. Traffic Fatality Explorer: an interactive D3 map of fatal crashes (NHTSA FARS, 1975–2024), normalized by county population (NCI SEER).

## Run the map

```
python -m http.server -d web 8000
```

Then open http://localhost:8000. The aggregated data in `web/data/` is committed, so the raw FARS files aren't needed to view the map.

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
