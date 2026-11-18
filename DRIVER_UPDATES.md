# Driver-focused updates

These changes make the explorer more useful for everyday drivers, our focus group. They follow the driver survey: 62.5% of respondents wanted a heat map, and unexpected merging or lane changes was one of the top concerns. They also address gaps listed in the prototype report.

## What changed

**1. The route comes first.**
"Check your drive" is now section 1, right under the search box. The other sections moved down one number:
1. Check your drive
2. At a glance
3. Map
4. Street level
5. When & weather
6. Compare & evaluate

A three-step guide under the header ("Check your drive → Explore your area → Dig into patterns") links to each part. The route button now reads **Check my drive**, and the example addresses are filled in so it works with one click.

**2. "Your drive" summary card.** After a route is checked, a plain-language card shows:
- **Totals:** crashes, deaths and deaths per 10 miles along the drive.
- **Trend:** crashes per year from the first year to the last, with a small trend line ("16 in 2020 → 26 in 2024, rising").
- **Worst stretches:** the top 3, with their main road and leading condition ("Miles 76–78 on SR-249: 14 deaths, 86% after dark").
- **What stands out:** factors that are clearly more common on this route than in the counties it passes through, for example "Pedestrian: 37% vs 29%". It compares against nearby roads rather than the whole country.
- **Driving tips:** short, practical tips for those factors.
- **Caveat:** a reminder that these are past crashes, not a prediction, and that busy roads carry more traffic.

**3. Time of trip.** A new "When do you usually drive?" choice (day and 2-hour window) shows:
- how many of the route's crashes happened in that window
- whether that's more or less than average for a window of that length (for example "0.3× the average: quieter than most times")
- those crashes highlighted on the map
- a small day × hour chart of the route's crashes with the chosen window outlined

**4. Crash-density heat map.** Both street maps (the route map and the county road view) have a **Dots | Heat map** switch. The heat map shows where fatal crashes cluster, with a "Fewer → More" legend. It follows the year range and filters.

**5. Lane changes and merging.**
- **Data split:** FARS records sideswipes as same direction (lane changes and merges) or opposite direction, but our data had combined them. The rebuilt data splits them: "Sideswipe, same direction (lane change or merge)" (20,138 crashes) and "Sideswipe, opposite direction" (16,537). The two add up to the old total of 36,675; all other crash types and every national total are unchanged.
- **Where it shows up:** the new type appears in the crash-type filter, the Compare crash-type chart, the "Focus on" chips and the route's "What stands out" list.

**6. "Focus on" chips.** One-click buttons apply common driver concerns as filters across every view:
- Lane changes & merging
- Drunk driving
- Speeding
- At night
- Rain
- Teen drivers

They appear in Check your drive, above the map's filters, and in the floating settings bar. There, a **Focus on** button opens the chips just above the bar and shows how many are on; clicking elsewhere closes it. All three sets stay in sync. Click a chip again to turn it off.

**7. Plainer wording and fairer rankings.**
- **Settings bar:** "Count: Deaths / Fatal crashes" and "Show: Per 100,000 residents (adjusted) / Per 100,000 residents / Total". This replaces "Fatalities", "Smoothed rate" and "Raw count".
- **Map legend and notes:** they explain the colors in everyday terms. The statistical method ("empirical Bayes") moved into a "How is this calculated?" link.
- **Top 10 counties:** counties with fewer than 10,000 residents are now left out, so a few crashes in a tiny county (such as Loving County, TX, with about 50 residents) no longer top the list.
- **Small places:** the side panel warns when a selected place has fewer than 10 deaths in the chosen years, because its numbers can swing a lot.
- **Help tips:** hovering over Count and Show explains them.

## Files changed

| File | Change |
|---|---|
| `prep/factors.py` | Splits sideswipes into same-direction (lane change/merge) and opposite-direction |
| `docs/data/*` | Rebuilt with `python prep/build_data.py` |
| `docs/index.html` | New section order, how-to strip, route form with trip time, summary and trip cards, chips, plainer labels, heat-map library |
| `docs/route.js` | Trip-time analysis and chart, "Your drive" card, heat-map mode, highlighting |
| `docs/county.js` | Shared Dots/Heat map switch and legend, used by both street maps |
| `docs/filters.js` | "Focus on" chips |
| `docs/main.js` | Plainer labels and notes, Top 10 population floor, small-number warning |
| `docs/compare.js` | Plainer rate label |
| `docs/style.css` | Styles for the new pieces and the green "Check your drive" accent |

## How it was checked

- **Rebuilt data:** the crash-type counts and national totals were compared with the previous build. They match, except for the intended sideswipe split.
- **Browser tests:** every new feature was exercised in a headless browser with no errors:
  - the route summary, trip time, heat maps on both maps, the chips and the Top 10 change
  - the trip-time count, recomputed independently from the route data
  - the lane-change death count (3,456 in 2020–2024), recomputed from the data files
- **Report tests:** the seven functional tests from the prototype report (T1–T7) still give the same results.

## Try it

Run `python -m http.server -d docs 8000` and open http://localhost:8000. Press **Check my drive**, pick "Weekdays, 4 PM–6 PM", then switch the map to **Heat map**.

## Round 2: more for drivers

**8. Distracted driving.** Distracted drivers were the survey's top concern (13 of 16 respondents).
- **Data:** the pipeline now reads FARS's driver-distraction table, which exists from 2010. A crash counts as distracted if any driver was recorded as distracted, for example:
  - phone use
  - passengers
  - vehicle controls
  - eating
  - something outside the vehicle
  - inattention or daydreaming

  "Looked but did not see" is left out as ambiguous. The flag is "not recorded" before 2010, and "unknown" when no driver's distraction was reported, which happens for about 60% of crashes since 2018. So distraction counts are a lower bound.
- **Checks:**
  - 2016 has 3,197 distracted fatal crashes, close to the 3,157 NHTSA published.
  - 2020–2024 has 16,474 deaths.
- **Where it shows up:**
  - a new filter
  - a "Distracted driving" Focus chip
  - a factor in the Compare chart
  - a "What stands out" factor and driving tip on the route card

**9. Most dangerous spots.**
- **What:** the county road view has a second tab next to "Deadliest roads". It lists places where several fatal crashes happened within about 100 m of each other, which is often an intersection or interchange.
- **Names:** each spot is named after its roads, e.g. "I-69 & US-59" or "Westheimer Rd & FM-1093".
- **Use:** clicking a spot zooms the map to it and highlights its crashes.

**10. Compare routes.** The routing service now returns up to three ways to make the same trip.
- **Table:** a "Compare routes" table shows miles, drive time, crashes, deaths and deaths per 10 miles for each route, and marks the one with the fewest deaths per mile.
- **Map:** clicking a route, or its dashed line on the map, switches every panel to it.
- **Show all routes:** the "Show all routes' crashes on the map" checkbox draws every route's crashes at once. Letter badges (A, B) mark each line, a crash near more than one route is drawn once, and its tooltip lists each route and mile. The summary, chart and tables still describe the selected route.
- **Example:** from College Station to Houston, Route B takes 4 more minutes but had 10.1 deaths per 10 miles vs 13.9 on the fastest route.

**11. Season of your trip.** "When do you usually drive?" now has a season choice (winter, spring, summer, fall) alongside the day and time. The trip-time panel compares that season's share of crashes with an average season and charts only that season.

**12. Save and share.**
- **Copy link to this drive:** makes a link that reopens the page with the same addresses, trip time, distance and years, and runs the route automatically.
- **Save as my usual drive:** fills that drive in next time the page opens. "Forget it" clears it.
- **Save as my area:** in the county view, opens the page on that county next time.
- **Copy link (county):** makes a link straight to that county's road view.
- **Privacy:** saved settings stay in your own browser.

**13. Dots colored by kind of crash.** On both street maps (route and county), each dot is colored by one of seven kinds of crash that drivers recognize:
- Head-on or oncoming
- Rear-end
- Angle (often at intersections)
- Lane change or merge
- Pedestrian or cyclist
- Single vehicle (ran off road, rollover)
- Other

The colors come from the Okabe–Ito palette, which stays distinguishable for color-blind viewers. A legend on each map lists the kinds present, with counts. Click kinds to spotlight them and fade the rest. Several kinds can be on at once (for example rear-end and lane change), click a kind again to turn it off, or press **Show all kinds**. Selected roads, spots, stretches and trip times now keep their colors with a dark outline, instead of turning orange.

**14. Rest stops along your drive.**
- **What:** the route map has a **Rest stops** switch, on by default. It shows rest areas and travel centers (truck stops, travel plazas) within 5 km of the route as blue "P" signs, from OpenStreetMap.
- **"Places to take a break":** the "Your drive" card lists them in route order with their mile, e.g. "Mile 64: Walker County Rest Area (both sides, restrooms)". Stops more than about a quarter mile from the route also show how far off the route they are ("1.8 mi off route").
- **Both sides:** a highway rest area mapped separately for each direction is merged into one entry.
- **How it's looked up:** a new prep script, `prep/rest_stops.py`, downloads every U.S. rest area and travel center from OpenStreetMap once, through the Overpass API, into `docs/data/rest_stops.json`. The page loads that file the first time a route is checked and keeps the stops within 5 km of the route line, so it works offline from the public Overpass servers. In testing those servers often took 40+ seconds or timed out.
- **Coverage:** stops missing from OpenStreetMap won't appear. Re-run `python prep/rest_stops.py` to refresh the data.

**15. Drowsy driving.**
- **Data:** the pipeline now also reads FARS's driver-impairment table (2010 on). A crash counts as drowsy if any driver was recorded as "asleep or fatigued". Records marked "not reported" or "unknown" count as unknown, so the counts are a lower bound.
- **Checks:** 832 deaths in 2016 and 700 in 2022, close to NHTSA's published 803 and 693.
- **Where it shows up:**
  - a filter
  - a "Drowsy driving" Focus chip
  - a factor in Compare
  - a "What stands out" factor on the route card, whose tip points to the rest stops listed beside it

**16. All statistics for a route.** Under "What stands out" on the route card, **See all statistics for this route** opens a table of every factor and kind of crash, not just the ones that stand out:
- **Factors:** after dark, distracted, drowsy, drinking, speeding, lane changes and merging, rain, large truck and pedestrian.
- **Kinds of crash:** the seven kinds used for the map colors.
- **Each row:** the share on your route and in the counties the route passes through, as numbers and paired bars, with the counts behind them.
- **Small samples:** factors that are often not reported (such as distraction) say how many crashes they're based on, and rows with fewer than 20 records are marked as a rough guide.
- **Highlights:** factors listed under "What stands out" are tagged in the table.
- **Stays open:** the table updates with the years, filters and trip time. "Hide" closes it.

**17. New page order.**
- **At a glance first:** "The United States at a glance" is section 1 again and "Check your drive" is section 2. The other sections keep their numbers (3 Map, 4 Street level, 5 When & weather, 6 Compare & evaluate).
- **Filters at the top:** the "Focus on" chips and the "Filter crashes by factor" panel moved out of the map section to the top of the page, under the search box, because they apply to every section.
- **Guide:** the guide under the header now has four steps, numbered to match the sections they link to.

Files for items 14–16: `prep/rest_stops.py` (new), `docs/data/rest_stops.json` (new), `prep/factors.py` and `prep/build_data.py` (drowsy flag), `docs/route.js` (rest-stop layer, "Places to take a break" list, drowsy factor, all-statistics table), `docs/county.js` (multi-kind legend), `docs/filters.js` and `docs/compare.js` (drowsy filter, chip and factor), `docs/style.css`.

### Files changed in round 2

| File | Change |
|---|---|
| `prep/factors.py`, `prep/build_data.py` | Distracted-driver flag from the DISTRACT table; factor coverage threshold lowered to 20% so partly reported distraction isn't treated as missing |
| `docs/data/*` | Rebuilt |
| `docs/county.js` | "Most dangerous spots" tab, crash-kind colors and legend, outline highlighting |
| `docs/route.js` | Alternative routes and the compare table, season of trip |
| `docs/share.js` (new) | Share links, saved drive, saved area |
| `docs/filters.js`, `docs/compare.js` | Distracted-driving filter label, chip, Compare factor |
| `docs/index.html`, `docs/style.css`, `docs/main.js` | New controls, tabs, buttons and styles |

All new features were tested in a headless browser with no errors. The seven functional tests from the prototype report still give the same results.
