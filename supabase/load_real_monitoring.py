"""
Load real monitoring data and lease boundaries (migration 12).

Run once, after migration_12_real_monitoring.sql:

    python load_real_monitoring.py

Safe to run again; nothing is added twice.

WHAT IT LOADS (all from files in raw_data/)
  1. River water quality, 2024 -- WQuality_River-Data-2024_parsed.csv,
     every station in CPCB's National Water Quality Monitoring Programme
     report for 2024 (parsed from the PDF). Stations on coal-belt rivers
     get approximate positions from nwmp_station_coordinates.csv, so each
     mine can be linked to the rivers near it.
  2. Pakri Barwadih's own air-quality station -- pakri_barwadih_caaqms_2023-24.csv,
     183 days of PM10, PM2.5, SO2 and NOx (1 Oct 2023 - 31 Mar 2024) from
     Annexure-59 of NTPC's six-monthly EC compliance report. Stored as real
     readings for that mine, with the report named as their source.
  3. Jamuniya UG's lease extent -- the latitude/longitude range stated in
     WCL's EC compliance report (Apr-Sep 2024 data sheet), stored as the
     mine's boundary so its geo-fence follows the lease instead of a circle.

To add a surveyed lease polygon from a KML file, use load_lease_boundary.py.
"""

import os

import pandas as pd
from supabase import create_client

from credentials import get_supabase_credentials

RAW = os.path.join(os.path.dirname(__file__), "raw_data")
url, key = get_supabase_credentials()
sb = create_client(url, key)


def num(v):
    try:
        f = float(v)
        return None if pd.isna(f) else f
    except (TypeError, ValueError):
        return None


def fetch_all(build):
    out, page = [], 0
    while True:
        chunk = build().range(page * 1000, page * 1000 + 999).execute().data or []
        out.extend(chunk)
        if len(chunk) < 1000:
            return out
        page += 1


def find_mine(name_like, district=None):
    q = sb.table("mines").select("mine_id, mine_name, district").ilike("mine_name", name_like)
    rows = q.execute().data or []
    if district:
        rows = [r for r in rows if (r.get("district") or "").strip().lower() == district.lower()] or rows
    return rows[0] if rows else None


# ------------------------------------------------------------------
# 1. River water quality, 2024
# ------------------------------------------------------------------
def load_rivers():
    df = pd.read_csv(os.path.join(RAW, "WQuality_River-Data-2024_parsed.csv"), dtype={"station_code": str})
    coords = pd.read_csv(os.path.join(RAW, "nwmp_station_coordinates.csv"), dtype={"station_code": str})
    where = {r.station_code: (r.latitude, r.longitude, r.located_at) for r in coords.itertuples()}

    have = {(r["station_code"], r["monitoring_location"]): r for r in fetch_all(
        lambda: sb.table("water_quality_records").select(
            "record_id, station_code, monitoring_location, latitude").eq("report_year", 2024))}
    new, placed = [], 0
    for r in df.itertuples():
        ll = where.get(r.station_code)
        k = (r.station_code, r.monitoring_location)
        if k in have:
            if ll and have[k].get("latitude") is None:
                sb.table("water_quality_records").update(
                    {"latitude": ll[0], "longitude": ll[1], "located_at": ll[2]}).eq(
                    "record_id", have[k]["record_id"]).execute()
                placed += 1
            continue
        new.append({
            "report_year": 2024, "station_code": r.station_code,
            "monitoring_location": r.monitoring_location, "river": r.river if isinstance(r.river, str) else None,
            "state": r.state.title() if isinstance(r.state, str) else None,
            "dissolved_oxygen_min": num(r.do_min), "dissolved_oxygen_max": num(r.do_max),
            "ph_min": num(r.ph_min), "ph_max": num(r.ph_max),
            "bod_min": num(r.bod_min), "bod_max": num(r.bod_max),
            "fecal_coliform_min": num(r.fc_min), "fecal_coliform_max": num(r.fc_max),
            "conductivity_min": num(r.cond_min), "conductivity_max": num(r.cond_max),
            "nitrate_min": num(r.nitrate_min), "nitrate_max": num(r.nitrate_max),
            "total_coliform_min": num(r.tc_min), "total_coliform_max": num(r.tc_max),
            "latitude": ll[0] if ll else None, "longitude": ll[1] if ll else None,
            "located_at": ll[2] if ll else None,
            "source": f"CPCB NWMP river water quality 2024, {r.table}, p. {r.page}",
        })
    for i in range(0, len(new), 500):
        sb.table("water_quality_records").insert(new[i:i + 500]).execute()
    print(f"1. River water quality 2024: {len(new)} stations added, {placed} placed on the map "
          f"({len(where)} coal-belt stations have positions)")


# ------------------------------------------------------------------
# 2. Pakri Barwadih CAAQMS readings
# ------------------------------------------------------------------
PAKRI_SOURCE = ("NTPC, Pakri Barwadih Coal Mining Project, six-monthly EC compliance report "
                "Oct 2023 - Mar 2024, Annexure-59 (continuous ambient air quality station)")


def load_pakri_barwadih():
    mine = find_mine("Pakri Barwadih%", "Hazaribagh")
    if not mine:
        print("2. Pakri Barwadih: mine not found in the mines table, skipped")
        return
    done = sb.table("env_readings").select("reading_id", count="exact").eq(
        "mine_id", mine["mine_id"]).eq("source_document", PAKRI_SOURCE).limit(1).execute().count
    if done:
        print(f"2. Pakri Barwadih: already loaded ({done} readings)")
        return
    df = pd.read_csv(os.path.join(RAW, "pakri_barwadih_caaqms_2023-24.csv"))
    rows = []
    for r in df.itertuples():
        for col, param in (("pm10", "PM10"), ("pm25", "PM2.5"), ("so2", "SO2"), ("nox", "NOx")):
            v = num(getattr(r, col))
            if v is None:
                continue
            rows.append({"mine_id": mine["mine_id"], "reading_date": r.reading_date, "parameter": param,
                         "value": v, "station_label": "CAAQMS (continuous station)",
                         "source_document": PAKRI_SOURCE, "is_synthetic": False})
    for i in range(0, len(rows), 500):
        sb.table("env_readings").insert(rows[i:i + 500]).execute()
    over = sum(1 for x in rows if x["parameter"] == "PM10" and x["value"] > 100)
    print(f"2. Pakri Barwadih: {len(rows)} real readings over {len(df)} days "
          f"({over} days with PM10 above the 24-hour limit)")


# ------------------------------------------------------------------
# 3. Jamuniya UG lease extent
# ------------------------------------------------------------------
def dms(d, m, s):
    return round(d + m / 60 + s / 3600, 6)


def load_jamuniya():
    mine = find_mine("JAMUNIA", "Chhindwara")
    if not mine:
        print("3. Jamuniya: mine not found in the mines table, skipped")
        return
    # EC data sheet: 22°16'49" - 22°18'07" N, 78°57'00" - 78°59'00" E
    s, n = dms(22, 16, 49), dms(22, 18, 7)
    w, e = dms(78, 57, 0), dms(78, 59, 0)
    ring = [[s, w], [s, e], [n, e], [n, w], [s, w]]
    sb.table("mine_boundaries").upsert({
        "mine_id": mine["mine_id"], "boundary": ring,
        "boundary_type": "Lease extent from EC report",
        "source": "WCL, Jamuniya UG six-monthly EC compliance report (Apr-Sep 2024), data sheet item 4(c)",
        "area_ha": 376.94,
    }, on_conflict="mine_id").execute()
    print(f"3. Jamuniya: lease extent stored for {mine['mine_name']} "
          f"({s}-{n} N, {w}-{e} E; lease area 376.94 ha)")


if __name__ == "__main__":
    load_rivers()
    load_pakri_barwadih()
    load_jamuniya()
    print("\nDone.")
