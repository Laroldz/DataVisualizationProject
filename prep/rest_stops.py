"""Download U.S. rest areas and travel centers from OpenStreetMap (Overpass API) into a small static file.

The route explorer filters these along a driving route in the browser, so the page never has to wait on
the public Overpass servers, which are often slow or busy.

Output: docs/data/rest_stops.json
  {"fields": ["lat", "lon", "kind", "name", "toilets"], "kinds": ["Rest area", "Travel center"], "stops": [[...], ...]}
  OpenStreetMap tags: highway=rest_area -> "Rest area", highway=services -> "Travel center" (truck stops, travel plazas).
Data (c) OpenStreetMap contributors, ODbL.

Each finished tile is cached in prep/raw/rest_stops_tiles/, so an interrupted run picks up where it stopped.
Delete that folder to download fresh data.

    python prep/rest_stops.py            # download every tile (resumes from the cache)
    python prep/rest_stops.py --cached   # write the file now from the tiles already downloaded
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "rest_stops.json"
CACHE = ROOT / "prep" / "raw" / "rest_stops_tiles"
SERVER = "https://overpass-api.de/api/interpreter"  # the public mirrors were down or timing out when this was written
WORKERS = 2                                           # overpass-api.de allows a couple of queries at once per user
KINDS = {"rest_area": 0, "services": 1}

# (south, west, north, east) regions, split into tiles small enough for Overpass to answer quickly.
REGIONS = [(24.4, -125.0, 49.5, -66.8),   # lower 48
           (51.0, -170.0, 71.5, -129.9),  # Alaska
           (18.8, -160.5, 22.4, -154.7)]  # Hawaii
TILE_LAT, TILE_LON = 4.0, 5.0


def tiles():
    for s, w, n, e in REGIONS:
        lat = s
        while lat < n:
            lon = w
            while lon < e:
                yield (lat, lon, min(lat + TILE_LAT, n), min(lon + TILE_LON, e))
                lon += TILE_LON
            lat += TILE_LAT


def fetch(box):
    b = ",".join(f"{v:.3f}" for v in box)
    cached = cache_file(box)
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    query = f'[out:json][timeout:120];(nwr["highway"="rest_area"]({b});nwr["highway"="services"]({b}););out center tags;'
    data = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(10):
        try:
            req = urllib.request.Request(SERVER, data=data, headers={"User-Agent": "DataVisProject-prep/1.0 (class project)"})
            res = json.loads(urllib.request.urlopen(req, timeout=180).read())
            if "remark" in res and "error" in res["remark"].lower():
                raise RuntimeError(res["remark"])
            cached.write_text(json.dumps(res["elements"]), encoding="utf-8")
            return res["elements"]
        except Exception as err:  # busy server: wait and try again
            print(f"  retry {attempt + 1} for {b}: {err}", flush=True)
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass failed for tile {b}; run the script again to resume")


def add(found, stops, seen):
    """Append one tile's rest areas and travel centers, skipping any already seen in a neighboring tile."""
    for e in found:
        key = (e["type"], e["id"])
        if key in seen:
            continue
        seen.add(key)
        tags = e.get("tags", {})
        lat = e.get("center", {}).get("lat", e.get("lat"))
        lon = e.get("center", {}).get("lon", e.get("lon"))
        if lat is None or tags.get("highway") not in KINDS:
            continue
        name = tags.get("name") or tags.get("brand") or ""
        stops.append([round(lat, 5), round(lon, 5), KINDS[tags["highway"]], name, 1 if tags.get("toilets") == "yes" else 0])


def cache_file(box):
    return CACHE / ("_".join(f"{v:.3f}" for v in box) + ".json")


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    stops, seen = [], set()
    all_tiles = list(tiles())
    if "--cached" in sys.argv:  # no downloading: use only the tiles finished so far
        missing = [box for box in all_tiles if not cache_file(box).exists()]
        for box in all_tiles:
            if box not in missing:
                add(json.loads(cache_file(box).read_text(encoding="utf-8")), stops, seen)
        print(f"{len(all_tiles) - len(missing)}/{len(all_tiles)} tiles cached; {len(missing)} not downloaded yet")
    else:
        missing = []
        with ThreadPoolExecutor(WORKERS) as pool:
            for i, found in enumerate(pool.map(fetch, all_tiles), 1):
                add(found, stops, seen)
                print(f"{i}/{len(all_tiles)} tiles, {len(stops):,} stops", flush=True)
    OUT.write_text(json.dumps({"fields": ["lat", "lon", "kind", "name", "toilets"], "kinds": ["Rest area", "Travel center"],
                               "source": "OpenStreetMap contributors (ODbL), via the Overpass API",
                               "missing_tiles": [list(box) for box in missing], "stops": stops},
                              separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(stops):,} stops to {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
