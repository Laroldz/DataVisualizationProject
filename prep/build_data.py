"""Aggregate FARS accident files + SEER county population into small CSVs for the web map.

Outputs (web/data/):
  county_year.csv  year,fips,crashes,fatals,pop
  state_year.csv   year,state,crashes,fatals,pop
"""
import gzip
import json
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
FARS = ROOT / "FARS_Data"
RAW = ROOT / "prep" / "raw"
OUT = ROOT / "web" / "data"
YEARS = range(1975, 2025)

SEER_URL = "https://seer.cancer.gov/popdata/yr1969_2024.20ages/us.1969_2024.20ages.adjusted.txt.gz"
ATLAS_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json"
UNKNOWN_COUNTY = {0, 997, 998, 999}

# County crosswalk (see SEER Appendix 1: https://seer.cancer.gov/popdata/modifications.html).
# FARS codes that were renamed or absorbed into a county that exists on the map.
FARS_RECODE = {
    12025: 12086,  # Miami-Dade
    46113: 46102,  # Shannon -> Oglala Lakota
    51515: 51019,  # Bedford City -> Bedford County
    51560: 51005,  # Clifton Forge -> Alleghany
    51780: 51083,  # South Boston -> Halifax
    30113: 30031,  # Yellowstone NP -> Gallatin
    2270: 2158,    # Wade Hampton -> Kusilvak
}
# SEER codes that are a single map county under another code.
SEER_RECODE = {8911: 8001, 8912: 8013, 8913: 8059, 8914: 8123, 51917: 51019, 2270: 2158, 46113: 46102}
# SEER codes that temporarily combine several counties; population is split using
# each member's share in the first year after the combination ends.
SEER_SPLIT = {
    2900: "state", 15900: "state",
    2010: [2013, 2016], 2910: [2070, 2164],
    4910: [4012, 4027],
    35910: [35006, 35061],
    36910: [36005, 36047, 36061, 36081, 36085],
    51910: [51153, 51683, 51685],
    51911: [51095, 51199, 51735, 51830],
    51913: [51089, 51690],
    51914: [51165, 51660],
    51915: [51177, 51179, 51630],
    51916: [51005, 51580],
    51918: [51013, 51059, 51510, 51600, 51610],
}


def download(url):
    path = RAW / url.rsplit("/", 1)[1]
    if not path.exists():
        print(f"Downloading {url}")
        RAW.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, path)
    return path


def accident_file(year):
    for p in (FARS / str(year) / "extracted").rglob("*"):
        if p.name.lower() == "accident.csv":
            return p
    raise FileNotFoundError(f"No accident file for {year}")


def load_fars():
    frames = []
    for year in YEARS:
        df = pd.read_csv(accident_file(year), encoding="latin-1", low_memory=False)
        df.columns = df.columns.str.replace("ï»¿", "").str.strip().str.upper()  # some years have a BOM
        frames.append(df[["STATE", "COUNTY", "FATALS"]].assign(YEAR=year))
    df = pd.concat(frames)
    df["FIPS"] = (df.STATE * 1000 + df.COUNTY).replace(FARS_RECODE)
    return df


def load_population():
    # SEER fixed-width: year[0:4] stfips[6:8] cofips[8:11] pop[18:26]
    rows = {}
    with gzip.open(download(SEER_URL), "rt") as f:
        for line in f:
            key = (int(line[0:4]), int(line[6:8]) * 1000 + int(line[8:11]))
            rows[key] = rows.get(key, 0) + int(line[18:26])
    pop = pd.Series(rows, name="pop")
    pop.index.names = ["year", "fips"]
    pop = pop.reset_index().query("year >= 1975")
    pop["fips"] = pop.fips.replace(SEER_RECODE)
    pop = pop.groupby(["year", "fips"])["pop"].sum()

    split = []
    for combo, members in SEER_SPLIT.items():
        years = pop.xs(combo, level="fips").index
        ref = pop.xs(years.max() + 1, level="year")
        if members == "state":
            members = [f for f in ref.index if f // 1000 == combo // 1000]
        shares = ref.reindex(members, fill_value=0)
        shares = shares / shares.sum()
        for y in years:
            split.append(pd.Series(pop[(y, combo)] * shares.values,
                                   index=pd.MultiIndex.from_product([[y], members], names=["year", "fips"])))
        pop = pop.drop(combo, level="fips")
    pop = pd.concat([pop, *split]).groupby(["year", "fips"]).sum().round().astype(int)
    return pop.rename("pop").reset_index()


def main():
    fars = load_fars()
    pop = load_population()

    known = fars[~fars.COUNTY.isin(UNKNOWN_COUNTY)]
    county = (known.groupby(["YEAR", "FIPS"])
              .agg(crashes=("FATALS", "size"), fatals=("FATALS", "sum"))
              .reset_index().rename(columns={"YEAR": "year", "FIPS": "fips"}))
    county = county.merge(pop, on=["year", "fips"], how="outer").fillna(0)
    county = county.astype(int).sort_values(["year", "fips"])

    state = (fars.groupby(["YEAR", "STATE"])
             .agg(crashes=("FATALS", "size"), fatals=("FATALS", "sum"))
             .reset_index().rename(columns={"YEAR": "year", "STATE": "state"}))
    state_pop = pop.assign(state=pop.fips // 1000).groupby(["year", "state"])["pop"].sum().reset_index()
    state = state.merge(state_pop, on=["year", "state"], how="left").fillna(0).astype(int)

    OUT.mkdir(parents=True, exist_ok=True)
    county.to_csv(OUT / "county_year.csv", index=False)
    state.to_csv(OUT / "state_year.csv", index=False)

    # Sanity report
    nat = state.groupby("year")[["fatals", "pop"]].sum()
    print(nat.loc[[1975, 1990, 2005, 2017, 2023, 2024]])

    shapes = {int(g["id"]) for g in json.load(open(download(ATLAS_URL)))["objects"]["counties"]["geometries"]}
    no_pop = county[(county["pop"] == 0) & (county.fatals > 0)]
    no_shape = county[~county.fips.isin(shapes) & (county.fatals > 0)]
    print(f"\nCounty-years with crashes but no population: {len(no_pop)} "
          f"({no_pop.fatals.sum()} fatalities); fips: {sorted(no_pop.fips.unique().tolist())[:30]}")
    print(f"County-years with crashes but no map shape: {len(no_shape)} "
          f"({no_shape.fatals.sum()} fatalities); fips: {sorted(no_shape.fips.unique().tolist())[:30]}")
    print(f"Fatalities with unknown county (state totals only): "
          f"{fars[fars.COUNTY.isin(UNKNOWN_COUNTY)].FATALS.sum()}")


if __name__ == "__main__":
    main()
