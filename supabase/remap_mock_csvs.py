"""
One-off: make the four mock CSVs agree with the real mines dataset.

The mock files (contractors, grievances, attendance, geo-inspections) were
generated with 15 mine names that are mostly real, but each row carried a
random subsidiary and, for inspections, random GPS points hundreds of km
from the named mine. Only about a quarter of rows resolved to a mine at
all, which is why the alerts engine skipped them.

This script rewrites them so that:
  * every row names a mine exactly as it appears in
    Indian_Coal_Mines_Dataset_January_2021 (the hand-checked MINE_MAP below);
  * the subsidiary is that mine's real owner;
  * inspection GPS points sit within ~2 km of the mine, apart from a few
    deliberately recorded off-site (8-10 km) so the geo-fence check has
    something to catch.
The rows themselves (dates, categories, counts, statuses) are unchanged and
remain synthetic -- they are still loaded with is_synthetic = true.

Already applied to the CSVs in raw_data/; kept for the record. Running it
again on the rewritten files is a no-op.
"""

import math
import os
import random

import pandas as pd

RAW = os.path.join(os.path.dirname(__file__), "raw_data")

# Mock name -> mine name in the Harvard dataset. Checked by hand against
# the dataset's owner, district and coordinates. Where the mock name is not
# itself a mine ("Singrauli OC", "Talcher OC", "Jharsuguda OC", "Sohagpur
# UG") it is mapped to a large mine in that coalfield or area.
MINE_MAP = {
    "Amlohri OC": "AMLOHRI",
    "Dipka OC": "DIPKA",
    "Gevra OC": "GEVRA OC",
    "Jhanjhara Project Colly": "Jhanjhara Project Colly",
    "Kusmunda OC": "KUSMUNDA",
    "Kusunda Colliery": "NEW GODHUR. KUSUNDA COLLIERY",
    "Madhusudanpur Colliery": "MAOHUSUDANPUR 7 PIT & INCLINE",   # dataset's own spelling
    "Manikpur UG": "MANIKPUR",
    "Nigahi OC": "NIGAHI",
    "Ningah Colliery": "Ningah Colliery",
    "Singrauli OC": "JAYANT",              # NCL, Singrauli coalfield
    "Sohagpur UG": "KHAIRAHA",             # SECL Sohagpur area, UG
    "Talcher OC": "ANANTA",                # MCL, Talcher coalfield
    "Moonidih Colliery": "MOONIDIH PROJECT",
    "Jharsuguda OC": "LAKHANPUR",          # MCL, Ib Valley, Jharsuguda
}


def norm(s):
    return " ".join(str(s).split()).strip()


def load_mines():
    df = pd.read_excel(os.path.join(RAW, "Indian_Coal_Mines_Dataset_January_2021-1.xlsx"),
                       sheet_name="Mines Datasheet")
    out = {}
    for _, r in df.iterrows():
        out[norm(r["Mine Name"])] = {
            "owner": str(r["Coal Mine Owner Name"]).strip(),
            "lat": float(r["Latitude "]), "lon": float(r["Longitude "]),
        }
    return out


def resolve(mines, name):
    real = MINE_MAP.get(name, name)
    real = norm(real)
    if real not in mines:
        raise SystemExit(f"{name!r} -> {real!r} is not in the mines dataset")
    return real, mines[real]


def offset(lat, lon, km, rng):
    """A point `km` from (lat, lon) in a random direction."""
    bearing = rng.uniform(0, 2 * math.pi)
    dlat = (km / 111.0) * math.cos(bearing)
    dlon = (km / (111.0 * math.cos(math.radians(lat)))) * math.sin(bearing)
    return round(lat + dlat, 6), round(lon + dlon, 6)


def main():
    mines = load_mines()
    rng = random.Random(20260926)

    for fname, col in (("contractors_mock.csv", "mine_assigned"), ("grievances_mock.csv", "mine"),
                       ("attendance_mock.csv", "mine"), ("geo_inspection_reports_mock.csv", "mine")):
        path = os.path.join(RAW, fname)
        df = pd.read_csv(path)
        names, subs = [], []
        for n in df[col]:
            real, m = resolve(mines, n)
            names.append(real)
            subs.append(m["owner"])
        df[col] = names
        df["subsidiary"] = subs

        if fname.startswith("geo_inspection"):
            off_site = set(rng.sample(range(len(df)), 4))
            lats, lons = [], []
            for i, n in enumerate(df[col]):
                m = mines[n]
                km = rng.uniform(8, 10) if i in off_site else rng.uniform(0.2, 2.0)
                la, lo = offset(m["lat"], m["lon"], km, rng)
                lats.append(la)
                lons.append(lo)
            df["latitude"], df["longitude"] = lats, lons

        df.to_csv(path, index=False)
        print(f"{fname}: {len(df)} rows, {df[col].nunique()} mines")


if __name__ == "__main__":
    main()
