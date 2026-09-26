"""
Bring an existing database onto the real data added in migration 11.

Run once, after migration_11_real_data.sql:

    python apply_real_data.py

It is safe to run again; the second run changes nothing.

WHAT IT DOES
  1. Stores each mine's actual 2019-20 production (Indian Coal Mines
     Dataset, January 2021) on the mine.
  2. Gives the coal-belt CPCB cities their coordinates
     (raw_data/cpcb_city_coordinates.csv), so every mine can be linked to
     its nearest air-quality station.
  3. Re-links the demo contractors, grievances, attendance and inspections
     to the real mines named in the corrected raw_data/*_mock.csv files
     (see remap_mock_csvs.py): right mine, right subsidiary, and inspection
     positions at the mine rather than hundreds of km away. Only rows marked
     is_synthetic are touched.
  4. Calls apply_real_data_links() in the database, which re-checks the
     geo-fence for those inspections, moves their alerts to the right mine
     and scales demo production to each mine's real output.

Afterwards run the jobs again so risk scores and alerts pick up the change:

    python risk_scoring_job.py
    python predictive_job.py
    python alerts_engine.py
"""

import datetime as dt
import os

import pandas as pd
from supabase import create_client

from credentials import get_supabase_credentials

RAW = os.path.join(os.path.dirname(__file__), "raw_data")
url, key = get_supabase_credentials()
sb = create_client(url, key)


def norm(s):
    return " ".join(str(s).split()).strip().lower()


def fetch_all(build):
    out, page = [], 0
    while True:
        chunk = build().range(page * 1000, page * 1000 + 999).execute().data or []
        out.extend(chunk)
        if len(chunk) < 1000:
            return out
        page += 1


# ------------------------------------------------------------------
# 1. Real production per mine
# ------------------------------------------------------------------
def load_mine_production():
    df = pd.read_excel(os.path.join(RAW, "Indian_Coal_Mines_Dataset_January_2021-1.xlsx"),
                       sheet_name="Mines Datasheet")
    real = {}
    for _, r in df.iterrows():
        v = r["Coal/ Lignite Production (MT) (2019-2020)"]
        if pd.notna(v):
            real[(norm(r["Mine Name"]), norm(r["District Name"]))] = round(float(v), 6)

    mines = fetch_all(lambda: sb.table("mines").select("mine_id, mine_name, district, production_2019_20_mt"))
    changed = 0
    for m in mines:
        v = real.get((norm(m["mine_name"]), norm(m["district"])))
        if v is None:
            continue
        cur = m.get("production_2019_20_mt")
        if cur is not None and abs(float(cur) - v) < 1e-9:
            continue
        sb.table("mines").update({"production_2019_20_mt": v}).eq("mine_id", m["mine_id"]).execute()
        changed += 1
    print(f"1. Production 2019-20: set on {changed} mines "
          f"({sum(1 for m in mines if (norm(m['mine_name']), norm(m['district'])) in real)} of {len(mines)} have a figure)")
    return {norm(m["mine_name"]): m["mine_id"] for m in mines}


# ------------------------------------------------------------------
# 2. Coordinates for the coal-belt CPCB cities
# ------------------------------------------------------------------
def load_air_coordinates():
    coords = pd.read_csv(os.path.join(RAW, "cpcb_city_coordinates.csv"))
    rows = fetch_all(lambda: sb.table("air_quality_records").select("record_id, city_town, state, latitude, longitude"))
    index = {(norm(c.city_town), norm(c.state)): (c.latitude, c.longitude) for c in coords.itertuples()}
    changed = 0
    for r in rows:
        ll = index.get((norm(r["city_town"]), norm(r["state"])))
        if not ll:
            continue
        if r.get("latitude") is not None and abs(float(r["latitude"]) - ll[0]) < 1e-6 \
                and abs(float(r["longitude"]) - ll[1]) < 1e-6:
            continue
        sb.table("air_quality_records").update({"latitude": ll[0], "longitude": ll[1]}).eq(
            "record_id", r["record_id"]).execute()
        changed += 1
    print(f"2. Air quality: coordinates set on {changed} CPCB cities ({len(index)} coal-belt cities in the file)")


# ------------------------------------------------------------------
# 3. Re-link the demo records
# ------------------------------------------------------------------
def subsidiary_ids():
    rows = sb.table("subsidiaries").select("subsidiary_id, subsidiary_code").execute().data or []
    return {r["subsidiary_code"]: r["subsidiary_id"] for r in rows}


def utc_key(ts):
    t = dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    if t.tzinfo:
        t = t.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return t.strftime("%Y-%m-%dT%H:%M:%S")


def relink(table, pk, csv, csv_mine_col, key_csv, key_db, select, extra=None, has_subsidiary=True):
    """Update synthetic rows of `table` to the mine (and subsidiary, and any
    `extra` fields) given for the matching row of the corrected CSV."""
    subs = subsidiary_ids()
    df = pd.read_csv(os.path.join(RAW, csv))
    wanted = {}
    for _, r in df.iterrows():
        mine_id = MINE_IDS.get(norm(r[csv_mine_col]))
        if not mine_id:
            print(f"   ! {r[csv_mine_col]!r} is not in the mines table; row skipped")
            continue
        patch = {"mine_id": mine_id}
        if has_subsidiary:
            patch["subsidiary_id"] = subs.get(r["subsidiary"])
        if extra:
            patch.update(extra(r))
        wanted[key_csv(r)] = patch

    rows = fetch_all(lambda: sb.table(table).select(f"{pk}, mine_id, {select}").eq("is_synthetic", True))
    changed = matched = 0
    for row in rows:
        patch = wanted.get(key_db(row))
        if not patch:
            continue
        matched += 1
        # Only send what differs, so a second run is a no-op.
        diff = {k: v for k, v in patch.items() if not same(row.get(k), v)}
        if not diff:
            continue
        sb.table(table).update(diff).eq(pk, row[pk]).execute()
        changed += 1
    print(f"   {table}: {matched} demo rows matched, {changed} corrected")


def same(a, b):
    if a is None or b is None:
        return a is b
    try:
        return abs(float(a) - float(b)) < 1e-6
    except (TypeError, ValueError):
        return str(a) == str(b)


def relink_all():
    print("3. Re-linking demo records to real mines")
    relink("contractors", "contractor_id", "contractors_mock.csv", "mine_assigned",
           # Name and contract value: unique in the file, and unlike the
           # contract dates they are never changed after loading.
           key_csv=lambda r: (r["contractor_name"], round(float(r["contract_value_inr_lakh"]), 2)),
           key_db=lambda d: (d["contractor_name"], round(float(d["contract_value_lakh_inr"] or 0), 2)),
           select="subsidiary_id, contractor_name, contract_value_lakh_inr")
    relink("grievances", "grievance_id", "grievances_mock.csv", "mine",
           key_csv=lambda r: (str(r["date_filed"]), r["category"]),
           key_db=lambda d: (str(d["date_filed"]), d["category"]),
           select="subsidiary_id, date_filed, category")
    relink("attendance_records", "record_id", "attendance_mock.csv", "mine",
           key_csv=lambda r: (str(r["date"]), r["shift"], int(r["workers_scheduled"]),
                              int(r["workers_present"]), int(r["contractors_present"])),
           key_db=lambda d: (str(d["attendance_date"]), d["shift"], int(d["workers_scheduled"]),
                             int(d["workers_present"]), int(d["contractors_present"])),
           select="subsidiary_id, attendance_date, shift, workers_scheduled, workers_present, contractors_present")
    relink("geo_inspections", "inspection_id", "geo_inspection_reports_mock.csv", "mine",
           key_csv=lambda r: (utc_key(r["timestamp"]), r["observation_type"], r["severity"]),
           key_db=lambda d: (utc_key(d["timestamp"]), d["observation_type"], d["severity"]),
           select="timestamp, observation_type, severity, latitude, longitude",
           extra=lambda r: {"latitude": float(r["latitude"]), "longitude": float(r["longitude"])},
           has_subsidiary=False)


if __name__ == "__main__":
    MINE_IDS = load_mine_production()
    load_air_coordinates()
    relink_all()
    result = sb.rpc("apply_real_data_links", {}).execute().data
    print("4. In the database:", result)
    print("\nDone. Now run risk_scoring_job.py, predictive_job.py and alerts_engine.py.")