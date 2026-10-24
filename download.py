
from pathlib import Path
import requests
import zipfile

BASE = "https://static.nhtsa.gov/nhtsa/downloads/FARS"
OUTPUT = Path("FARS_Data")

for year in range(1975, 2025):
    folder = OUTPUT / str(year)
    folder.mkdir(parents=True, exist_ok=True)

    filename = f"FARS{year}NationalCSV.zip"
    path = folder / filename
    url = f"{BASE}/{year}/National/{filename}"

    if path.exists() and zipfile.is_zipfile(path):
        print(f"{year}: Already downloaded")
        continue

    try:
        print(f"Downloading {year}...")

        with requests.get(url, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(path, "wb") as f:
                for chunk in r.iter_content(1024 * 1024):
                    if chunk:
                        f.write(chunk)

        if not zipfile.is_zipfile(path):
            raise ValueError("Invalid ZIP archive")

        with zipfile.ZipFile(path) as z:
            z.extractall(folder / "extracted")

        print(f"{year}: Complete")

    except Exception as e:
        path.unlink(missing_ok=True)
        print(f"{year}: Failed - {e}")
