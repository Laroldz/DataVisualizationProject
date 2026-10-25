"""Harmonize FARS crash factors across 1975-2024 into two packed integers per crash.

FARS renamed and recoded many variables over the years (e.g. WEATHER was renumbered in
2010, speeding moved from driver-factor codes to SPEEDREL in 2009, body types were
recoded in 1982 and 1991). Each function below maps one era's codes onto one shared set
of categories. web/filters.js decodes the same layout, so keep the two in sync.

  cats (uint32): categorical fields, CAT_BITS wide each, in CATEGORIES order; 0 = unknown
  flags (uint32): 2 bits per flag in FLAGS order; 0 = not recorded that year, 1 = no, 2 = yes
"""
import numpy as np
import pandas as pd

CATEGORIES = {  # name -> labels for codes 1..n
    "weather": ["Clear / cloudy", "Rain", "Snow, sleet or ice", "Fog, smoke or other"],
    "light": ["Daylight", "Dawn or dusk", "Dark, lighted", "Dark, not lighted"],
    "surface": ["Dry", "Wet", "Snow, ice or slush", "Other (sand, oil, mud)"],
    "crash_type": ["Head-on", "Rear-end", "Angle", "Sideswipe", "Other vehicle collision",
                   "Pedestrian struck", "Bicyclist struck", "Rollover", "Fixed object or other"],
    "road_type": ["Interstate or freeway", "Arterial", "Collector", "Local road"],
    "area": ["Rural", "Urban"],
}
CAT_BITS = 4
FLAGS = ["alcohol", "speeding", "pedestrian", "bicyclist", "motorcycle", "large_truck",
         "hit_run", "work_zone", "young_driver", "older_driver"]


def _map(series, table, default=0):
    return series.map(table).fillna(default).astype(int)


def weather(a, year):
    w = a["WEATHER"]
    if year < 2010:
        return _map(w, {1: 1, 2: 2, 3: 3, 4: 3, 5: 4, 6: 4, 7: 4, 8: 4})
    return _map(w, {1: 1, 10: 1, 2: 2, 3: 3, 4: 3, 11: 3, 12: 3, 5: 4, 6: 4, 7: 4, 8: 4})


def light(a, year):
    # 1975-79 used code 6 for dawn/dusk; from 2009, 6 is "dark, unknown lighting".
    six = 2 if year < 1980 else 4 if year >= 2009 else 0
    return _map(a["LGT_COND"], {1: 1, 2: 4, 3: 3, 4: 2, 5: 2, 6: six})


def surface(a, v, year):
    if "SUR_COND" in a:
        return _map(a["SUR_COND"], {1: 1, 2: 2, 6: 2, 3: 3, 4: 3, 5: 4, 7: 4, 8: 4})
    # From 2010 surface is recorded per vehicle; use vehicle 1.
    v1 = v[v.VEH_NO == 1].set_index("ST_CASE")["VSURCOND"]
    s = a["ST_CASE"].map(v1)
    return _map(s, {1: 1, 2: 2, 6: 2, 3: 3, 4: 3, 10: 3, 5: 4, 7: 4, 8: 4, 11: 4})


def crash_type(a, year):
    harm, man = a["HARM_EV"], a["MAN_COLL"]
    if year < 2002:
        coll = {1: 2, 2: 1, 4: 3, 5: 4, 6: 4}
    elif year < 2010:
        coll = {1: 2, 2: 1, 3: 3, 4: 3, 5: 3, 6: 3, 7: 4, 8: 4}
    else:
        coll = {1: 2, 2: 1, 6: 3, 7: 4, 8: 4}
    out = pd.Series(9, index=a.index)          # fixed object / other
    out[harm == 1] = 8                          # rollover
    out[harm == 8] = 6                          # pedestrian
    out[harm == 9] = 7                          # pedalcyclist
    mv = harm == 12                             # collision with motor vehicle in transport
    out[mv] = man[mv].map(coll).fillna(5).astype(int)
    return out


def road_type(a, year):
    if "FUNC_SYS" in a:
        return _map(a["FUNC_SYS"], {1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4})
    if "ROAD_FNC" not in a or a["ROAD_FNC"].isna().all():
        return pd.Series(0, index=a.index)
    if year < 1987:  # 1981-86 scheme, no rural/urban split
        return _map(a["ROAD_FNC"], {1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 3, 8: 4})
    return _map(a["ROAD_FNC"], {1: 1, 11: 1, 12: 1, 2: 2, 3: 2, 13: 2, 14: 2, 4: 3, 5: 3, 15: 3, 6: 4, 16: 4})


def area(a, year):
    if "RUR_URB" in a:
        return _map(a["RUR_URB"], {1: 1, 2: 2})
    if year >= 1987:
        r = a["ROAD_FNC"]
        return pd.Series(np.select([r.between(1, 9), r.between(11, 19)], [1, 2], 0), index=a.index)
    if "LAND_USE" not in a:
        return pd.Series(0, index=a.index)
    return _map(a["LAND_USE"], {2: 1, 1: 2})  # 1 = urban, 2 = rural


def any_by_case(a, df, mask):
    """Per-crash yes/no from a vehicle- or person-level condition."""
    hit = set(df.loc[mask, "ST_CASE"])
    return a["ST_CASE"].isin(hit)


def flags(a, v, p, year):
    yes = {}
    # Alcohol: police-reported drinking driver. DRUNK_DR (crash level) is derived from the
    # vehicle-level DR_DRINK and matches it exactly from 1982-2020; it was dropped after 2020.
    yes["alcohol"] = a["DRUNK_DR"] > 0 if "DRUNK_DR" in a else any_by_case(a, v, v.DR_DRINK == 1)
    # Speeding-related: driver factor 43/44/46 (too fast / racing) until 2008, SPEEDREL after.
    if "SPEEDREL" in v:
        yes["speeding"] = any_by_case(a, v, v.SPEEDREL.between(1, 5))
    else:
        cf = [c for c in v.columns if c.startswith("DR_CF")]
        yes["speeding"] = any_by_case(a, v, v[cf].isin([43, 44, 46]).any(axis=1))
    ped, cyc = ((3,), (4,)) if year < 1982 else ((5,), (6, 7))
    yes["pedestrian"] = any_by_case(a, p, p.PER_TYP.isin(ped))
    yes["bicyclist"] = any_by_case(a, p, p.PER_TYP.isin(cyc))
    body = v.BODY_TYP
    if year < 1982:
        yes["motorcycle"] = any_by_case(a, v, body == 15)
        yes["large_truck"] = None  # body types before 1982 don't separate large trucks reliably
    elif year < 1991:
        yes["motorcycle"] = any_by_case(a, v, body.between(20, 29))
        yes["large_truck"] = any_by_case(a, v, body.between(70, 79))
    else:
        yes["motorcycle"] = any_by_case(a, v, body.between(80, 89))
        yes["large_truck"] = any_by_case(a, v, body.isin([60, 61, 62, 63, 64, 66, 71, 72, 78]))
    yes["hit_run"] = any_by_case(a, v, v.HIT_RUN.between(1, 5) if year < 2009 else v.HIT_RUN == 1)
    if "WRK_ZONE" in a:
        yes["work_zone"] = a["WRK_ZONE"].between(1, 4)
    elif "C_M_ZONE" in a and a["C_M_ZONE"].notna().any():
        yes["work_zone"] = a["C_M_ZONE"].between(1, 4)
    else:
        yes["work_zone"] = None
    unknown_age = 998 if year >= 2009 else 98
    drivers = p[(p.PER_TYP == 1) & (p.AGE < unknown_age)]
    yes["young_driver"] = any_by_case(a, drivers, drivers.AGE.between(15, 20))
    yes["older_driver"] = any_by_case(a, drivers, drivers.AGE >= 65)

    packed = np.zeros(len(a), dtype=np.int64)
    for i, name in enumerate(FLAGS):
        if yes[name] is None:
            continue
        packed |= np.where(np.asarray(yes[name]), 2, 1).astype(np.int64) << (2 * i)
    return packed


def encode(a, v, p, year):
    """Return (cats, flags) arrays aligned with accident rows `a`."""
    fields = {
        "weather": weather(a, year), "light": light(a, year), "surface": surface(a, v, year),
        "crash_type": crash_type(a, year), "road_type": road_type(a, year), "area": area(a, year),
    }
    cats = np.zeros(len(a), dtype=np.int64)
    for i, name in enumerate(CATEGORIES):
        cats |= np.asarray(fields[name], dtype=np.int64) << (CAT_BITS * i)
    return cats, flags(a, v, p, year)
