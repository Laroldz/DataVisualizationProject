"""Extract dated state traffic-law changes from the Correlates of State Policy Project (CSPP).

Source: Grossmann, Jordan & McCrain, "The Correlates of State Policy Project", v2.6,
IPPSR, Michigan State University (https://ippsr.msu.edu/public-policy/correlates-state-policy).
The traffic variables come from Silver & Macinko (2013, from IIHS/NIAAA), Sorens et al.
("Freedom in the 50 States") and Boehmke & Skinner; see the CSPP codebook.

CSPP is a state-year panel, and its variables don't share one timing convention (some record
the law in force on Jan 1, others the year it was enacted). A change first seen in year Y is
therefore treated as taking effect in Y-1 or Y, and the before/after view skips both years.
Where CSPP has a second variable for the same law, events that disagree by more than a year
are dropped instead of guessed.

Output: web/data/policies.json, a list of
  {state, year, category, label, detail, source}
"""
import json
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "prep" / "raw"
OUT = ROOT / "web" / "data" / "policies.json"
URL = "https://ippsr.msu.edu/sites/default/files/cspp/correlates2-6.csv"
CSPP = "Correlates of State Policy Project v2.6 (IPPSR, Michigan State Univ.)"

COLS = ["year", "state_fips", "baclimits", "dui", "primaryenforce", "primaryenforce_all", "seatbeltlaw",
        "helmetlaw", "dhelmall", "slrural", "dcell", "gdl", "docont"]


def load():
    path = RAW / "correlates2-6.csv"
    if not path.exists():
        RAW.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {URL}")
        urllib.request.urlretrieve(URL, path)
    d = pd.read_csv(path, usecols=COLS, encoding="latin-1", low_memory=False)
    return d[d.year.between(1970, 2024) & d.state_fips.notna()].astype({"state_fips": int})


def transitions(d, var, on, years=None):
    """Years where `on(value)` flips between consecutive observed years, per state.
    Yields (state, year, now_on, before_value, after_value)."""
    for st, g in d[["state_fips", "year", var]].dropna().groupby("state_fips"):
        g = g.sort_values("year")
        if years:
            g = g[g.year.between(*years)]
        prev = None
        for y, v in zip(g.year, g[var]):
            if prev is not None and y == prev[0] + 1 and on(v) != on(prev[1]):
                yield st, int(y), on(v), prev[1], v
            prev = (y, v)


def first_on(d, var, on):
    """Per state, first observed year in which `on(value)` holds (used only as a cross-check;
    a law already on in the variable's first year counts as starting that year)."""
    g = d[["state_fips", "year", var]].dropna()
    g = g[g[var].map(on)]
    return g.groupby("state_fips").year.min().astype(int).to_dict()


def agree(year, check_year, tolerance=1):
    return check_year is None or abs(year - check_year) <= tolerance


def build(d):
    events = []
    add = lambda st, y, cat, label, detail, src: events.append(
        {"state": int(st), "year": int(y), "category": cat, "label": label, "detail": detail, "source": src})

    # 0.08 BAC: baclimits (NIAAA via Silver & Macinko), cross-checked against `dui` (Boushey).
    dui = first_on(d, "dui", lambda v: v == 1)
    for st, y, now, a, b in transitions(d, "baclimits", lambda v: v <= 0.0801):
        # The two BAC variables use different timing conventions (e.g. Minnesota, in force Aug 2005:
        # dui says 2004, baclimits 2006), so allow 2 years; Utah (1983 vs 1998) is dropped.
        if now and agree(y, dui.get(st), tolerance=2):
            add(st, y, "bac", "0.08 BAC limit", f"Legal limit lowered from {a:.2f} to 0.08", f"{CSPP}: baclimits")

    # Primary seat-belt enforcement: primaryenforce==2 (1980-2010), then primaryenforce_all (2011+).
    prim = first_on(d, "primaryenforce_all", lambda v: v == 1)
    for st, y, now, *_ in transitions(d, "primaryenforce", lambda v: v == 2):
        if now and agree(y, prim.get(st)):
            add(st, y, "seat_belt", "Primary seat-belt enforcement",
                "Police may stop drivers for not wearing a seat belt", f"{CSPP}: primaryenforce")
    for st, y, now, *_ in transitions(d, "primaryenforce_all", lambda v: v == 1, (2011, 2024)):
        if now:
            add(st, y, "seat_belt", "Primary seat-belt enforcement",
                "Police may stop drivers for not wearing a seat belt", f"{CSPP}: primaryenforce_all")

    # First adult seat-belt law.
    for st, y, now, *_ in transitions(d, "seatbeltlaw", lambda v: v >= 1):
        if now:
            add(st, y, "seat_belt", "First seat-belt law", "Adult seat-belt use required", f"{CSPP}: seatbeltlaw")

    # Universal motorcycle helmet law: helmetlaw==2 (1980-2010), then dhelmall (2011+).
    helm_all = {(st, y): now for st, y, now, *_ in transitions(d, "dhelmall", lambda v: v == 1)}
    for st, y, now, *_ in transitions(d, "helmetlaw", lambda v: v == 2):
        # Where both variables cover the year (2001-2010), require them to agree.
        other = [n for (s, yy), n in helm_all.items() if s == st and abs(yy - y) <= 1]
        if y > 2000 and other != [now]:
            continue
        add(st, y, "helmet", "Universal helmet law " + ("adopted" if now else "repealed"),
            "All motorcyclists must wear helmets" if now else "Helmets no longer required for all adult riders",
            f"{CSPP}: helmetlaw")
    for (st, y), now in helm_all.items():
        if y >= 2011:
            add(st, y, "helmet", "Universal helmet law " + ("adopted" if now else "repealed"),
                "All motorcyclists must wear helmets" if now else "Helmets no longer required for all adult riders",
                f"{CSPP}: dhelmall")

    # Rural interstate speed limit changes (120 = no numeric daytime limit, Montana 1995-99).
    mph = lambda v: "no numeric limit" if v >= 100 else f"{int(v)} mph"
    for st, g in d[["state_fips", "year", "slrural"]].dropna().groupby("state_fips"):
        g = g.sort_values("year")
        for (y0, v0), (y1, v1) in zip(zip(g.year, g.slrural), list(zip(g.year, g.slrural))[1:]):
            if y1 == y0 + 1 and v1 != v0:
                add(st, y1, "speed", f"Rural interstate limit {'raised' if v1 > v0 else 'lowered'} to {mph(v1)}",
                    f"Maximum rural interstate speed limit changed from {mph(v0)} to {mph(v1)}", f"{CSPP}: slrural")

    # Handheld phone ban for all drivers (dcell == 2).
    for st, y, now, *_ in transitions(d, "dcell", lambda v: v == 2):
        if now:
            add(st, y, "phone", "Handheld phone ban", "Statewide ban on handheld phones for all drivers", f"{CSPP}: dcell")

    for var, cat, label, detail in [
        ("gdl", "young", "Graduated driver licensing", "Staged licensing for new teen drivers"),
        ("docont", "alcohol_other", "Open-container law", "Open alcohol containers banned in vehicles"),
    ]:
        for st, y, now, *_ in transitions(d, var, lambda v: v == 1):
            if now:
                add(st, y, cat, label, detail, f"{CSPP}: {var}")

    # A first seat-belt law that was primary from the start is one event, not two.
    firsts = {(e["state"], e["year"]) for e in events if e["label"] == "First seat-belt law"}
    for e in events:
        if e["label"] == "Primary seat-belt enforcement" and (e["state"], e["year"]) in firsts:
            e["label"], e["detail"] = "First seat-belt law (primary enforcement)", \
                "Adult seat-belt use required; police may stop drivers for it"
    events = [e for e in events if not (e["label"] == "First seat-belt law" and (e["state"], e["year"]) in
                                         {(x["state"], x["year"]) for x in events if x["label"].endswith("(primary enforcement)")})]
    return sorted(events, key=lambda e: (e["state"], e["year"], e["category"]))


def main():
    events = build(load())
    OUT.write_text(json.dumps(events, separators=(",", ":")))
    df = pd.DataFrame(events)
    print(f"Wrote {len(events)} policy changes for {df.state.nunique()} states to {OUT.relative_to(ROOT)}")
    print(df.groupby("category").year.agg(["count", "min", "max"]))


if __name__ == "__main__":
    main()
