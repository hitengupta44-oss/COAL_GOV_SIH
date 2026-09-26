"""
Seed loader for the Coal Mining Governance Platform (Supabase).

Run this AFTER you've:
  1. Created a Supabase project
  2. Run schema.sql in the SQL editor
  3. Run it -- you will be prompted for your Supabase URL and service_role key
     (or export them as env vars beforehand to skip the prompts)
  4. Placed the 19 dataset files (from datasets/) in ./raw_data/

    pip install -r requirements.txt
    python load_seed_data.py

Coverage (17 of 19 files loaded by this script):
  - Indian_Coal_Mines_Dataset_January_2021-1.xlsx  -> mines
  - table3_inspections_enquiries_2024.csv          -> dgms_inspection_stats
  - table4_improvement_notices_coal_2024.csv       -> dgms_violation_categories
  - table8_permissions_relaxations_exemptions...   -> permissions_exemptions
  - table_fatal_accidents_totals_2017_2024.csv     -> accidents (national, BG/OC/AG)
  - table_fatal_accidents_owner_wise_2017_2024.csv -> accidents (per subsidiary, BG/OC/AG)
  - RS_Session_256_AU_3306_1.csv                   -> accidents (state-wise, fatal + serious)
  - RS_Session_265_AU_52_B.csv                     -> production_records (per subsidiary)
  - coal_dataset_2.pdf (hardcoded below)           -> production_records (national, CIL/SCCL/Others)
  - coal_dataset_2.xlsx                            -> accidents (individual fatal incidents, 2020-23)
  - contractors_mock.csv                           -> contractors
  - grievances_mock.csv                            -> grievances
  - attendance_mock.csv                            -> attendance_records
  - geo_inspection_reports_mock.csv                -> geo_inspections
  - AIRQUALITY_DATA2023_transcribed.csv            -> air_quality_records (transcribed from the PDF, see NOTES)
  - WQuality_Data-2025_transcribed.csv             -> water_quality_records (transcribed from the PDF, see NOTES)
  - statutory_compliance_items_transcribed.csv     -> statutory_compliance_items (hand-curated from coal_dataset_3.pdf, see NOTES)
  - dgms_owner_wise_serious_accidents_2017_2024_transcribed.csv -> accidents
      (owner-wise + national totals, transcribed from COAL_DATASET_11_ANNUAL_REPORT.pdf, see NOTES)

Still needs manual work -- see NOTES at the bottom:
  - coal_dataset_1.pdf (Coal Directory) -- turned out to be a statistics
    yearbook, not a regulations document (see NOTES); no loader needed/planned.
  - COAL_DATASET_11_ANNUAL_REPORT.pdf -- its Table 2.9 (owner-wise serious
    accidents) is now loaded above; the rest of the report (cause-wise
    accident analysis, legislation narrative, occupational health) is
    still untapped -- good candidate for AI-chat grounding context later.
"""

import os
import re
import uuid
import pandas as pd
from supabase import create_client, Client
from credentials import get_supabase_credentials


SUPABASE_URL, SUPABASE_KEY = get_supabase_credentials()
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

RAW_DIR = "./raw_data"

SUBSIDIARY_CODES = ["ECL", "BCCL", "CCL", "NCL", "SECL", "MCL", "WCL", "SCCL", "NEC", "NLC"]

# Maps the long-form owner/company names found in coal_dataset_2.xlsx to the
# short subsidiary codes used everywhere else. Names not in this map (private
# power/steel companies that also run captive mines) resolve to None --
# subsidiary_id stays null but the raw owner name is kept in `source`.
OWNER_NAME_TO_CODE = {
    "eastern coalfields ltd.": "ECL",
    "bharat coking coal ltd.": "BCCL",
    "central coalfields ltd.": "CCL",
    "northern coalfields ltd.": "NCL",
    "south eastern coalfields ltd.": "SECL",
    "mahanadi coalfields ltd.": "MCL",
    "western coalfields ltd.": "WCL",
    "sccl.": "SCCL",
    "sccl": "SCCL",
    "nlcil": "NLC",
}


def ensure_subsidiaries():
    """Idempotently create base subsidiary rows referenced by everything else."""
    existing = supabase.table("subsidiaries").select("subsidiary_code").execute().data
    existing_codes = {r["subsidiary_code"] for r in existing}
    rows = []
    for code in SUBSIDIARY_CODES:
        if code in existing_codes:
            continue
        rows.append({
            "subsidiary_code": code,
            "subsidiary_name": code,
            "parent_company": "Coal India Limited" if code not in ("SCCL", "NLC") else None,
            "ownership_type": "Joint Venture" if code == "SCCL" else "Government",
        })
    if rows:
        supabase.table("subsidiaries").insert(rows).execute()
        print(f"Inserted {len(rows)} subsidiaries")


def subsidiary_id_map():
    data = supabase.table("subsidiaries").select("subsidiary_id, subsidiary_code").execute().data
    id_map = {r["subsidiary_code"]: r["subsidiary_id"] for r in data}
    # table_fatal_accidents_owner_wise_2017_2024.csv and
    # dgms_owner_wise_serious_accidents_2017_2024_transcribed.csv both spell
    # NLC's company column as "NLCL" (NLC India Limited), not "NLC" -- without
    # this alias, every NLC accident row silently loses its subsidiary_id.
    if "NLC" in id_map:
        id_map["NLCL"] = id_map["NLC"]
    return id_map


def load_mines_from_harvard_xlsx():
    path = os.path.join(RAW_DIR, "Indian_Coal_Mines_Dataset_January_2021-1.xlsx")
    if not os.path.exists(path):
        print("SKIP: mines xlsx not found")
        return
    df = pd.read_excel(path, sheet_name="Mines Datasheet")
    sub_map = subsidiary_id_map()
    rows = []
    for _, r in df.iterrows():
        owner = str(r.get("Coal Mine Owner Name", "")).strip()
        rows.append({
            "mine_id": str(uuid.uuid4()),
            "mine_name": str(r.get("Mine Name", "")).strip(),
            "state": r.get("State/UT Name"),
            "district": r.get("District Name"),
            "subsidiary_id": sub_map.get(owner),
            "coal_type": r.get("Coal/Lignite"),
            "mine_type": r.get("Type of Mine (OC/UG/Mixed)"),
            "ownership": "Government" if r.get("Govt Owned/Private") == "G" else "Private",
            "latitude": r.get("Latitude "),
            "longitude": r.get("Longitude "),
            "geo_accuracy": r.get("Accuracy (exact vs approximate)"),
            "source_reference": "Indian_Coal_Mines_Dataset_January_2021",
        })
    # batch insert, 500 rows at a time
    for i in range(0, len(rows), 500):
        supabase.table("mines").insert(rows[i:i + 500]).execute()
    print(f"Inserted {len(rows)} mines")


# ------------------------------------------------------------
# Mine-name fuzzy matcher -- the mock/RS-question CSVs and coal_dataset_2.xlsx
# use short, inconsistently-cased mine names ("Talcher OC") that don't
# exactly match the Harvard dataset's names ("TALCHER"). This is best-effort
# matching for demo/mock data -- not guaranteed to be correct, and
# intentionally conservative (skips ambiguous matches rather than guessing
# wrong).
#
# Two-stage approach:
#   1. Group Harvard mines by their first significant token. If a target
#      name's first token has exactly one candidate mine, that's the match.
#   2. If the first token has MULTIPLE candidates (e.g. several mines all
#      starting with "Amalgamated"), disambiguate using Jaccard overlap
#      across ALL significant tokens (not just the first) -- pick the
#      candidate with the single highest overlap score. If there's a tie
#      for the top score, or no overlap at all, give up rather than guess.
# This roughly doubles the resolvable ambiguous cases vs. first-token-only
# matching (verified against coal_dataset_2.xlsx: 152 individual fatal-
# accident rows go from 85 matched to 97 matched, with the newly-resolved
# ones spot-checked by hand -- no false positives introduced).
# ------------------------------------------------------------
_STOPWORDS = {"oc", "ug", "colliery", "collieries", "project", "proj", "mine", "mines",
              "ocp", "ocm", "opencast", "open", "cast", "incline", "block", "quarry",
              "extension", "no", "the", "and", "a", "b", "c", "i", "ii", "iii", "iv", "v",
              "ia", "ro", "u", "g", "khani", "1a", "qry", "captive"}


def _normalize_mine_name(name: str) -> str:
    return re.sub(r"[^a-z0-9 ]", " ", str(name).lower()).strip()


def _significant_tokens(name: str) -> list:
    return [t for t in _normalize_mine_name(name).split() if t not in _STOPWORDS and not t.isdigit()]


def build_mine_lookup():
    """Fetch all mines once and index them by their first significant word,
    keeping each candidate's full token set for later Jaccard disambiguation."""
    data = supabase.table("mines").select("mine_id, mine_name").execute().data
    lookup = {}
    for row in data:
        toks = _significant_tokens(row["mine_name"])
        if not toks:
            continue
        lookup.setdefault(toks[0], []).append((row["mine_id"], set(toks)))
    return lookup


def find_mine_id(mine_lookup: dict, name: str):
    toks = _significant_tokens(name)
    if not toks:
        return None
    candidates = mine_lookup.get(toks[0])
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0][0]

    # Multiple mines share the first token -- disambiguate by full token overlap.
    target_set = set(toks)
    scored = [(mine_id, len(target_set & cand_toks) / len(target_set | cand_toks))
              for mine_id, cand_toks in candidates]
    scored.sort(key=lambda x: -x[1])
    best_score = scored[0][1]
    if best_score == 0:
        return None  # no real overlap beyond the shared first token -- too risky to guess
    top = [s for s in scored if s[1] == best_score]
    if len(top) == 1:
        return top[0][0]
    return None  # genuine tie between two+ equally-good candidates -- skip rather than guess


def load_dgms_csvs():
    files = {
        "table3_inspections_enquiries_2024.csv": ("dgms_inspection_stats", lambda r: {
            "report_year": 2024,
            "mine_category": r["mine_category"],
            "inspections": r["inspections"],
            "enquiries": r["enquiries"],
        }),
        "table4_improvement_notices_coal_2024.csv": ("dgms_violation_categories", lambda r: {
            "report_year": 2024,
            "order_type": "Improvement Notice",
            "defect_nature": r["nature_of_defect"],
            "no_of_cases": r["no_of_cases"],
        }),
        "table8_permissions_relaxations_exemptions_coal_2024.csv": ("permissions_exemptions", lambda r: {
            "report_year": 2024,
            "particulars": r["particulars"],
            "no_of_cases": r["no_of_cases"],
        }),
    }
    for fname, (table, mapper) in files.items():
        path = os.path.join(RAW_DIR, fname)
        if not os.path.exists(path):
            print(f"SKIP: {fname} not found")
            continue
        df = pd.read_csv(path)
        rows = [mapper(r) for _, r in df.iterrows() if str(r.get("nature_of_defect", "")) != "Total"
                and str(r.get("particulars", "")) != "Total"]
        if rows:
            supabase.table(table).insert(rows).execute()
        print(f"Loaded {len(rows)} rows into {table} from {fname}")


def load_national_fatal_accident_totals():
    """table_fatal_accidents_totals_2017_2024.csv -> accidents, one row per
    year per location_type (Belowground/Opencast/Aboveground)."""
    path = os.path.join(RAW_DIR, "table_fatal_accidents_totals_2017_2024.csv")
    if not os.path.exists(path):
        print("SKIP: table_fatal_accidents_totals_2017_2024.csv not found")
        return
    df = pd.read_csv(path)
    location_cols = [
        ("Belowground", "bg_accidents", "bg_killed"),
        ("Opencast", "oc_accidents", "oc_killed"),
        ("Aboveground", "ag_accidents", "ag_killed"),
    ]
    rows = []
    for _, r in df.iterrows():
        for location_type, acc_col, killed_col in location_cols:
            count = int(r[acc_col])
            if count == 0:
                continue
            rows.append({
                "year": int(r["year"]),
                "severity": "Fatal",
                "location_type": location_type,
                "accident_count": count,
                "persons_affected": int(r[killed_col]),
                "source": "DGMS Annual Report totals (table_fatal_accidents_totals_2017_2024.csv)",
            })
    if rows:
        supabase.table("accidents").insert(rows).execute()
    print(f"Loaded {len(rows)} rows into accidents from table_fatal_accidents_totals_2017_2024.csv")


def load_owner_wise_fatal_accidents():
    """table_fatal_accidents_owner_wise_2017_2024.csv -> accidents, one row
    per company per year per location_type."""
    path = os.path.join(RAW_DIR, "table_fatal_accidents_owner_wise_2017_2024.csv")
    if not os.path.exists(path):
        print("SKIP: table_fatal_accidents_owner_wise_2017_2024.csv not found")
        return
    sub_map = subsidiary_id_map()
    df = pd.read_csv(path)
    location_cols = [
        ("Belowground", "bg_accidents", "bg_killed"),
        ("Opencast", "oc_accidents", "oc_killed"),
        ("Aboveground", "ag_accidents", "ag_killed"),
    ]
    rows = []
    for _, r in df.iterrows():
        company = str(r["company"]).strip()
        for location_type, acc_col, killed_col in location_cols:
            count = int(r[acc_col])
            if count == 0:
                continue
            rows.append({
                "subsidiary_id": sub_map.get(company),
                "year": int(r["year"]),
                "severity": "Fatal",
                "location_type": location_type,
                "accident_count": count,
                "persons_affected": int(r[killed_col]),
                "source": f"table_fatal_accidents_owner_wise_2017_2024.csv (company: {company})",
            })
    if rows:
        for i in range(0, len(rows), 500):
            supabase.table("accidents").insert(rows[i:i + 500]).execute()
    print(f"Loaded {len(rows)} rows into accidents from table_fatal_accidents_owner_wise_2017_2024.csv")


def load_state_accidents_rs256():
    """RS_Session_256_AU_3306_1.csv -> accidents, state-wise fatal + serious
    counts (persons_affected left null -- the source gives accident counts,
    not casualty counts)."""
    path = os.path.join(RAW_DIR, "RS_Session_256_AU_3306_1.csv")
    if not os.path.exists(path):
        print("SKIP: RS_Session_256_AU_3306_1.csv not found")
        return
    df = pd.read_csv(path)
    rows = []
    for _, r in df.iterrows():
        for severity, col in [("Fatal", "No. of Fatal Accident"), ("Serious", "No. of Serious Accident")]:
            count = int(r[col])
            if count == 0:
                continue
            rows.append({
                "state": r["State"],
                "year": int(r["Year"]),
                "severity": severity,
                "accident_count": count,
                "persons_affected": None,
                "source": "RS_Session_256_AU_3306_1.csv (state-wise, DGMS)",
            })
    if rows:
        for i in range(0, len(rows), 500):
            supabase.table("accidents").insert(rows[i:i + 500]).execute()
    print(f"Loaded {len(rows)} rows into accidents from RS_Session_256_AU_3306_1.csv")


def load_individual_fatal_incidents_xlsx(mine_lookup: dict):
    """coal_dataset_2.xlsx -> accidents, one row per individual fatal
    incident (2020-2023), mine-level detail where the mine name matches
    the Harvard mines dataset."""
    path = os.path.join(RAW_DIR, "coal_dataset_2.xlsx")
    if not os.path.exists(path):
        print("SKIP: coal_dataset_2.xlsx not found")
        return
    sub_map = subsidiary_id_map()
    df = pd.read_excel(path)
    rows = []
    for _, r in df.iterrows():
        mine_name = str(r["Name of the Coal Mine"]).strip()
        owner = str(r["Owner"]).strip()
        code = OWNER_NAME_TO_CODE.get(owner.lower())
        mine_id = find_mine_id(mine_lookup, mine_name)
        accident_date = r["Date of accident"]
        rows.append({
            "mine_id": mine_id,
            "subsidiary_id": sub_map.get(code) if code else None,
            "accident_date": accident_date.date().isoformat() if hasattr(accident_date, "date") else str(accident_date),
            "year": int(r["Year"]),
            "severity": "Fatal",
            "accident_count": 1,
            "persons_affected": int(r["Killed"]),
            "source": f"coal_dataset_2.xlsx (mine: {mine_name}, owner: {owner})",
        })
    if rows:
        for i in range(0, len(rows), 500):
            supabase.table("accidents").insert(rows[i:i + 500]).execute()
    matched = sum(1 for r in rows if r["mine_id"])
    print(f"Loaded {len(rows)} rows into accidents from coal_dataset_2.xlsx ({matched} matched to a mine_id)")


def load_national_production_from_coal_dataset_2():
    """Hardcoded from coal_dataset_2.pdf ('Company Wise Production/Despatch
    of Raw Coal during last ten years'). This PDF is an Excel-exported chart
    page -- text extraction is clean, but there's no tabular structure to
    parse automatically, so the 10-year series is transcribed here once."""
    years = ["2015-16", "2016-17", "2017-18", "2018-19", "2019-20",
              "2020-21", "2021-22", "2022-23", "2023-24", "2024-25"]
    production = {
        "CIL": [538.75, 554.14, 567.37, 606.89, 602.13, 596.22, 622.63, 703.2, 773.806, 781.056],
        "SCCL": [60.38, 61.34, 62.01, 64.4, 64.04, 50.58, 65.02, 67.14, 70.021, 69.006],
        "Others/Captive": [40.09, 42.39, 46.03, 57.43, 64.7, 69.29, 90.56, 122.85, 153.999, 197.461],
    }
    dispatch = {
        "CIL": [534.08, 542.98, 580.01, 607.95, 581.23, 573.63, 661.89, 694.55, 753.533, 762.832],
        "SCCL": [58.69, 60.79, 64.62, 67.67, 62.47, 48.51, 65.53, 66.69, 69.858, 65.264],
        "Others/Captive": [39.67, 42.21, 45.37, 57.17, 63.07, 68.75, 91.94, 116.13, 149.618, 197.237],
    }
    rows = []
    for group in production:
        for i, year in enumerate(years):
            rows.append({
                "fiscal_year": year,
                "subsidiary_id": None,
                "company_group": group,
                "production_mt": production[group][i],
                "dispatch_mt": dispatch[group][i],
                "source": "coal_dataset_2.pdf (Company Wise Production/Despatch of Raw Coal, last 10 years)",
            })
    supabase.table("production_records").insert(rows).execute()
    print(f"Loaded {len(rows)} rows into production_records from coal_dataset_2.pdf (national, hardcoded)")


def load_subsidiary_production_rs265():
    """RS_Session_265_AU_52_B.csv -> production_records, per-subsidiary
    production + revenue. RS Session 265 was confirmed (via sansad.in /
    news coverage) to be the Budget Session 2024, sitting 22 July - 9 Aug
    2024 -- the first full Budget session of the newly-elected government's
    third term. RS answers of this kind conventionally report the most
    recently completed financial year, so fiscal_year is set to '2023-24'
    with that reasoning noted in `source` -- flag it if you can trace the
    original starred/unstarred question text for an exact confirmation."""
    path = os.path.join(RAW_DIR, "RS_Session_265_AU_52_B.csv")
    if not os.path.exists(path):
        print("SKIP: RS_Session_265_AU_52_B.csv not found")
        return
    sub_map = subsidiary_id_map()
    df = pd.read_csv(path)
    rows = []
    for _, r in df.iterrows():
        name = str(r["Subsidiaries"]).strip()
        if name.lower() == "grand total":
            continue
        match = re.search(r"\(([A-Z]+)\)", name)
        code = match.group(1) if match else None
        rows.append({
            "fiscal_year": "2023-24 (inferred -- RS Session 265 sat 22 Jul-9 Aug 2024; confirm against the original question text for certainty)",
            "subsidiary_id": sub_map.get(code),
            "company_group": code,
            "production_mt": r["Production (Million Tonne)"],
            "revenue_crore": r["Amount (Rs. in Crore)"],
            "source": "RS_Session_265_AU_52_B.csv",
        })
    if rows:
        supabase.table("production_records").insert(rows).execute()
    print(f"Loaded {len(rows)} rows into production_records from RS_Session_265_AU_52_B.csv")


def load_mock_csvs(mine_lookup: dict):
    sub_map = subsidiary_id_map()

    # Contractors
    path = os.path.join(RAW_DIR, "contractors_mock.csv")
    if os.path.exists(path):
        df = pd.read_csv(path)
        rows = [{
            "contractor_name": r["contractor_name"],
            "mine_id": find_mine_id(mine_lookup, r["mine_assigned"]) if "mine_assigned" in df.columns else None,
            "subsidiary_id": sub_map.get(r["subsidiary"]),
            "contract_type": r["contract_type"],
            "contract_start": r["contract_start"],
            "contract_end": r["contract_end"],
            "contract_value_lakh_inr": r["contract_value_inr_lakh"],
            "status": r["status"],
            "blacklisted": r["blacklisted"] == "Yes",
            "is_synthetic": True,
        } for _, r in df.iterrows()]
        supabase.table("contractors").insert(rows).execute()
        print(f"Loaded {len(rows)} mock contractors")

    # Grievances
    path = os.path.join(RAW_DIR, "grievances_mock.csv")
    if os.path.exists(path):
        df = pd.read_csv(path)
        rows = [{
            "mine_id": find_mine_id(mine_lookup, r["mine"]) if "mine" in df.columns else None,
            "subsidiary_id": sub_map.get(r["subsidiary"]),
            "date_filed": r["date_filed"],
            "category": r["category"],
            "description": r["description_short"],
            "status": r["status"],
            "days_to_resolve": None if pd.isna(r["days_to_resolve"]) else int(r["days_to_resolve"]),
            "escalated": r["escalated"] == "Yes",
            "is_synthetic": True,
        } for _, r in df.iterrows()]
        supabase.table("grievances").insert(rows).execute()
        print(f"Loaded {len(rows)} mock grievances")

    # Attendance
    path = os.path.join(RAW_DIR, "attendance_mock.csv")
    if os.path.exists(path):
        df = pd.read_csv(path)
        rows = [{
            "mine_id": find_mine_id(mine_lookup, r["mine"]),
            "subsidiary_id": sub_map.get(r["subsidiary"]),
            "attendance_date": r["date"],
            "shift": r["shift"],
            "workers_scheduled": int(r["workers_scheduled"]),
            "workers_present": int(r["workers_present"]),
            "contractors_present": int(r["contractors_present"]),
            "absentee_pct": r["absentee_pct"],
            "is_synthetic": True,
        } for _, r in df.iterrows()]
        for i in range(0, len(rows), 500):
            supabase.table("attendance_records").insert(rows[i:i + 500]).execute()
        print(f"Loaded {len(rows)} mock attendance records")

    # Geo-inspections (web-submitted field inspections; see backend/app.py's
    # log_field_inspection). inspector_id is left null for this mock batch
    # since these synthetic inspector codes (e.g. "INS148") don't correspond
    # to real user_profiles rows -- wire it up once real inspector accounts exist.
    path = os.path.join(RAW_DIR, "geo_inspection_reports_mock.csv")
    if os.path.exists(path):
        df = pd.read_csv(path)
        rows = [{
            "mine_id": find_mine_id(mine_lookup, r["mine"]),
            "timestamp": r["timestamp"],
            "latitude": r["latitude"],
            "longitude": r["longitude"],
            "observation_type": r["observation_type"],
            "severity": r["severity"],
            "corrective_action_status": r["corrective_action_status"],
            "is_synthetic": True,
        } for _, r in df.iterrows()]
        for i in range(0, len(rows), 500):
            supabase.table("geo_inspections").insert(rows[i:i + 500]).execute()
        print(f"Loaded {len(rows)} mock geo-inspections")


def load_air_quality():
    """AIRQUALITY_DATA2023_transcribed.csv -> air_quality_records. Transcribed
    from AIRQUALITY_DATA2023.pdf (CPCB, 2023) using pdfplumber table
    extraction -- all 400 state/city rows, national coverage (not filtered
    to coal-belt states, since mine_id linking is left for a future manual
    pass -- 'NM' and '-' in the source are loaded as null)."""
    path = os.path.join(RAW_DIR, "AIRQUALITY_DATA2023_transcribed.csv")
    if not os.path.exists(path):
        print("SKIP: AIRQUALITY_DATA2023_transcribed.csv not found")
        return
    df = pd.read_csv(path)
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "report_year": int(r["report_year"]),
            "state": r["state"],
            "city_town": r["city_town"],
            "so2_annual_avg": None if pd.isna(r["so2_annual_avg"]) else r["so2_annual_avg"],
            "no2_annual_avg": None if pd.isna(r["no2_annual_avg"]) else r["no2_annual_avg"],
            "pm10_annual_avg": None if pd.isna(r["pm10_annual_avg"]) else r["pm10_annual_avg"],
            "pm25_annual_avg": None if pd.isna(r["pm25_annual_avg"]) else r["pm25_annual_avg"],
            "source": "CPCB AIRQUALITY_DATA2023 (transcribed from PDF)",
        })
    for i in range(0, len(rows), 500):
        supabase.table("air_quality_records").insert(rows[i:i + 500]).execute()
    print(f"Loaded {len(rows)} rows into air_quality_records")


def load_water_quality():
    """WQuality_Data-2025_transcribed.csv -> water_quality_records.
    Transcribed from WQuality_Data-2025.pdf (CPCB river Yamuna monitoring,
    2025) -- 32 monitoring stations. Note: this dataset covers the Yamuna
    only, not coal-belt rivers specifically; keep that in mind when
    correlating with mine locations."""
    path = os.path.join(RAW_DIR, "WQuality_Data-2025_transcribed.csv")
    if not os.path.exists(path):
        print("SKIP: WQuality_Data-2025_transcribed.csv not found")
        return
    df = pd.read_csv(path)
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "report_year": int(r["report_year"]),
            "station_code": str(r["station_code"]),
            "monitoring_location": r["monitoring_location"],
            "state": r["state"],
            "dissolved_oxygen_min": r["dissolved_oxygen_min"],
            "dissolved_oxygen_max": r["dissolved_oxygen_max"],
            "ph_min": r["ph_min"],
            "ph_max": r["ph_max"],
            "bod_min": r["bod_min"],
            "bod_max": r["bod_max"],
            "fecal_coliform_min": r["fecal_coliform_min"],
            "fecal_coliform_max": r["fecal_coliform_max"],
            "source": "CPCB WQuality_Data-2025 (transcribed from PDF)",
        })
    supabase.table("water_quality_records").insert(rows).execute()
    print(f"Loaded {len(rows)} rows into water_quality_records")


def load_statutory_compliance_items():
    """statutory_compliance_items_transcribed.csv -> statutory_compliance_items.
    29 hand-curated, paraphrased rows summarising the Coal Mines Regulations,
    2017 (coal_dataset_3.pdf -- the actual Gazette notification of GSR
    1449(E), dated 27 Nov 2017). Spans Chapters II-XVII: returns/notices,
    duties of owners/contractors/suppliers, safety management plans,
    opencast working precautions, gassiness classification, fire
    precautions, ventilation, explosives storage, methane extraction
    notices, fencing, and PPE requirements. Deliberately paraphrased, not
    copied verbatim, per this table's own schema comment."""
    path = os.path.join(RAW_DIR, "statutory_compliance_items_transcribed.csv")
    if not os.path.exists(path):
        print("SKIP: statutory_compliance_items_transcribed.csv not found")
        return
    df = pd.read_csv(path)
    rows = df.to_dict(orient="records")
    supabase.table("statutory_compliance_items").insert(rows).execute()
    print(f"Loaded {len(rows)} rows into statutory_compliance_items")


def load_owner_wise_serious_accidents():
    """dgms_owner_wise_serious_accidents_2017_2024_transcribed.csv -> accidents.
    Transcribed from COAL_DATASET_11_ANNUAL_REPORT.pdf (DGMS Annual Report
    2024), Table 2.9 -- owner-wise serious-accident statistics, 2017-2024.
    This data doesn't exist anywhere else in the loaded datasets (the other
    accident files are all fatal-only, or serious-but-state-wide rather
    than per-owner) -- inserts BOTH the owner-wise rows (subsidiary_id set
    where the company is a CIL/SCCL subsidiary) AND a national-total row
    per year/location_type (subsidiary_id null), mirroring how fatal
    accidents are loaded via load_national_fatal_accident_totals +
    load_owner_wise_fatal_accidents. persons_affected holds the seriously-
    injured count (S/Inj. in the source), not a death count."""
    path = os.path.join(RAW_DIR, "dgms_owner_wise_serious_accidents_2017_2024_transcribed.csv")
    if not os.path.exists(path):
        print("SKIP: dgms_owner_wise_serious_accidents_2017_2024_transcribed.csv not found")
        return
    sub_map = subsidiary_id_map()
    df = pd.read_csv(path)
    location_cols = [
        ("Belowground", "bg_accidents", "bg_injured"),
        ("Opencast", "oc_accidents", "oc_injured"),
        ("Aboveground", "ag_accidents", "ag_injured"),
    ]

    owner_rows = []
    for _, r in df.iterrows():
        company = str(r["company"]).strip()
        for location_type, acc_col, injured_col in location_cols:
            count = int(r[acc_col])
            injured = int(r[injured_col])
            if count == 0 and injured == 0:
                continue
            owner_rows.append({
                "subsidiary_id": sub_map.get(company),  # None for non-CIL/SCCL owners (SASAN Power, TATA Steel, etc.)
                "year": int(r["year"]),
                "severity": "Serious",
                "location_type": location_type,
                "accident_count": count,
                "persons_affected": injured,
                "source": f"DGMS Annual Report 2024, Table 2.9 (company: {company})",
            })
    if owner_rows:
        for i in range(0, len(owner_rows), 500):
            supabase.table("accidents").insert(owner_rows[i:i + 500]).execute()
    print(f"Loaded {len(owner_rows)} owner-wise rows into accidents from DGMS Annual Report 2024 Table 2.9")

    national_totals = df.groupby("year")[["bg_accidents", "bg_injured", "oc_accidents",
                                            "oc_injured", "ag_accidents", "ag_injured"]].sum().reset_index()
    total_rows = []
    for _, r in national_totals.iterrows():
        for location_type, acc_col, injured_col in location_cols:
            count = int(r[acc_col])
            injured = int(r[injured_col])
            if count == 0 and injured == 0:
                continue
            total_rows.append({
                "year": int(r["year"]),
                "severity": "Serious",
                "location_type": location_type,
                "accident_count": count,
                "persons_affected": injured,
                "source": "DGMS Annual Report 2024, Table 2.9 (national total)",
            })
    if total_rows:
        supabase.table("accidents").insert(total_rows).execute()
    print(f"Loaded {len(total_rows)} national-total rows into accidents from DGMS Annual Report 2024 Table 2.9")


if __name__ == "__main__":
    ensure_subsidiaries()
    load_mines_from_harvard_xlsx()
    load_dgms_csvs()
    load_national_fatal_accident_totals()
    load_owner_wise_fatal_accidents()
    load_state_accidents_rs256()
    load_national_production_from_coal_dataset_2()
    load_subsidiary_production_rs265()

    mine_lookup = build_mine_lookup()
    load_individual_fatal_incidents_xlsx(mine_lookup)
    load_mock_csvs(mine_lookup)

    load_air_quality()
    load_water_quality()
    load_statutory_compliance_items()
    load_owner_wise_serious_accidents()

    print("Seed load complete.")

# ------------------------------------------------------------
# NOTES: remaining files
# ------------------------------------------------------------
# - coal_dataset_1.pdf ("Coal Directory of India 2024-25"): on inspection
#   this is a 266-page STATISTICS YEARBOOK (production, despatch, stock,
#   pricing, royalty, import/export, washery performance, captive blocks,
#   world coal stats, mine counts) published by the Ministry of Coal -- not
#   a regulations/legal document. It doesn't contain compliance rules, so
#   there's nothing to add to statutory_compliance_items from it. Its Table
#   12.1 ("Company Wise Number of Producing Coal & Lignite Mines as on
#   31/03/2025") is a fresher mine count than our 2021 Harvard mines
#   dataset and could be used as a cross-check/reconciliation source later,
#   but doesn't map to an existing table on its own.
# - coal_dataset_3.pdf is the real regulations document: the Gazette
#   notification of the Coal Mines Regulations, 2017 (G.S.R. 1449(E),
#   27 Nov 2017), bilingual Hindi/English, 280 pages, 17 chapters. This is
#   the source for statutory_compliance_items_transcribed.csv above -- 29
#   rows were hand-picked and paraphrased to cover all four categories, but
#   the regulations run to 240+ individual provisions across explosives,
#   winding, haulage, electricity, methane extraction, etc. Extend the CSV
#   with more rows (same columns) any time; the loader just re-reads it.
# - COAL_DATASET_11_ANNUAL_REPORT.pdf: broad annual-report PDF: useful as a
#   cross-check / narrative source (e.g. for the AI chat's grounding context)
#   but doesn't map cleanly to one table -- no loader written for it yet.
# - RS_Session_265_AU_52_B.csv: fiscal_year RESOLVED. Confirmed via web
#   search that RS Session 265 = Budget Session 2024, sitting 22 July to
#   9 August 2024 (the newly-elected government's first full Budget
#   session, third term). Set fiscal_year to '2023-24' on the standard
#   assumption that such RS answers report the most recently completed
#   financial year -- still worth a final check against the original
#   question's exact wording if you need certainty for an audit trail.
# - COAL_DATASET_11_ANNUAL_REPORT.pdf is the DGMS Annual Report 2024. Its
#   Table 2.9 ("Owner-wise consolidated serious accident statistics for the
#   last 8 years in coal mines") was genuinely new data -- nowhere else in
#   the loaded datasets has owner-wise SERIOUS accident stats (only
#   owner-wise FATAL, and state-wide serious) -- transcribed into
#   dgms_owner_wise_serious_accidents_2017_2024_transcribed.csv and loaded
#   above (cross-checked: every year's totals match the source's own Total
#   row exactly). Its Table 2.8 (owner-wise fatal accidents) was checked
#   and is an exact duplicate of table_fatal_accidents_owner_wise_2017_2024.csv
#   already loaded -- skipped to avoid double-counting. The rest of the
#   report -- cause-wise accident analysis (Sec 2.2.3), legislation
#   history, occupational health, non-coal-mine stats -- is narrative/
#   analytical rather than tabular-and-schema-shaped, and is a good
#   candidate for AI-chat grounding context rather than a new table.
# - AIRQUALITY_DATA2023_transcribed.csv covers all-India cities, not just
#   coal-belt ones, and air_quality_records.mine_id is left null for every
#   row -- linking specific stations to nearby mines (by district) is a
#   manual/geo-matching pass for later, same as the schema comment notes.
# - WQuality_Data-2025_transcribed.csv covers the Yamuna river monitoring
#   network only (the only river in the source PDF) -- it's a general
#   environmental-quality reference, not coal-mine-specific effluent data.