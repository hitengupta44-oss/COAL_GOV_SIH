"""
Load official annual coal grade declarations (migration 15).

    python load_declared_grades.py

Reads every raw_data/*_declared_grades_*.csv. The one supplied is MCL's
"Declaration of Annual Coal Grade of Combined Coal Seams and Dispatch
Points of MCL Mines for the year 2025-2026" (order no. 1251, dated
31.03.2025, effective 01.04.2025), transcribed row by row: 38 dispatch
points in 10 areas.

The column mine_grade_for names, in the mines table's spelling, the mines
whose coal a row declares -- e.g. BOCM III ("G14 grade coal of ILBL OCP")
covers LAKHANPUR, BELPAHAR and LILARI, the Integrated Lilari-Belpahar-
Lakhanpur opencast. Each mine is named on one row only.

Safe to run again: rows are updated in place, not duplicated. To add
another subsidiary's declaration, transcribe it into a CSV with the same
columns (e.g. secl_declared_grades_2025-26.csv) and run this again.
"""

import glob
import os

import pandas as pd
from supabase import create_client

from credentials import get_supabase_credentials

RAW = os.path.join(os.path.dirname(__file__), "raw_data")
SOURCES = {
    "MCL": "MCL order no. 1251 dated 31.03.2025, Declaration of Annual Coal Grade of Combined Coal Seams "
           "and Dispatch Points of MCL Mines for 2025-26 (Colliery Control (Amendment) Rules 2021, rule 4(3)-(4))",
}


def main():
    url, key = get_supabase_credentials()
    sb = create_client(url, key)
    mines = sb.table("mines").select("mine_id, mine_name").execute().data or []
    by_name = {}
    for m in mines:
        by_name.setdefault(" ".join(m["mine_name"].split()).upper(), []).append(m["mine_id"])

    files = sorted(glob.glob(os.path.join(RAW, "*_declared_grades_*.csv")))
    if not files:
        raise SystemExit("No *_declared_grades_*.csv files in raw_data/.")
    total, linked, missing = 0, set(), []
    for path in files:
        df = pd.read_csv(path, dtype=str).fillna("")
        rows = []
        for r in df.itertuples():
            ids = []
            for name in [n.strip() for n in r.mine_grade_for.split(";") if n.strip()]:
                found = by_name.get(" ".join(name.split()).upper(), [])
                if len(found) == 1:
                    ids.append(found[0])
                    linked.add(name)
                else:
                    missing.append(f"{name} ({len(found)} matches)")
            rows.append({
                "subsidiary": r.subsidiary, "fy": r.fy, "area": r.area, "dispatch_point": r.dispatch_point,
                "point_type": r.point_type, "seams": r.seams or None, "location": r.location or "",
                "grade": r.grade, "provisional": r.provisional.strip().lower() == "true", "mine_ids": ids,
                "source": SOURCES.get(r.subsidiary, os.path.basename(path)),
            })
        sb.table("declared_grades").upsert(
            rows, on_conflict="subsidiary,fy,area,dispatch_point,location").execute()
        total += len(rows)
        print(f"{os.path.basename(path)}: {len(rows)} dispatch points")
    print(f"Linked the official grade to {len(linked)} mines: {', '.join(sorted(linked))}")
    if missing:
        print("Not found in the mines table (not linked): " + "; ".join(missing))


if __name__ == "__main__":
    main()
