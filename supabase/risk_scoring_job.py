"""
Risk-scoring analytics job -- populates ai_risk_flags.

WHY THIS EXISTS
---------------
frontend/pages/dashboard/corporate.js already calls getHighRiskMines(), and
backend/app.py's get_high_risk_mines() already reads straight from
ai_risk_flags -- that wiring was built already. This script is the missing
piece: the thing that actually computes and writes the flags. Run it once
after seeding (load_seed_data.py + seed_compliance_tracking.py), then on a
schedule (cron / Supabase scheduled function / GitHub Action) to keep it
fresh as new accidents/inspections/compliance data comes in.

    pip install -r requirements.txt
    python risk_scoring_job.py

FOUR FLAG TYPES (matches the ai_risk_flags.flag_type check constraint)
-----------------------------------------------------------------------
1. Anomalous Accident Rate
   Mines with a fatal-accident count (from the individual, mine-matched
   incidents in coal_dataset_2.xlsx -- the only accident source with real
   mine_id linkage) more than 1 standard deviation above the mean across
   all mines that have at least one recorded fatal accident.
   LIMITATION: most accident sources in this dataset are national/
   subsidiary-level aggregates with no mine_id, so this only sees the ~85
   mines matched from coal_dataset_2.xlsx. Extending mine-level accident
   coverage would directly improve this flag.

2. Recurring Violation
   Mines with 2+ unresolved (Open/Overdue) High or Critical severity
   geo_inspections findings. "Recurring" = more than one, not a one-off.

3. Compliance Gap
   Mines where the overdue share of applicable compliance_tracking items
   exceeds 15%, or there are 3+ overdue items outright.

4. Environmental Threshold Breach
   Mines near a monitored city in air_quality_records that exceeds a CPCB
   NAAQS annual limit (PM10 > 60, PM2.5 > 40, SO2 > 50, NO2 > 40 ug/m3).
   Uses GRADUATED confidence rather than a flat state-wide flag:
     - DISTRICT-LEVEL match (higher confidence, higher risk_score): the
       breaching city's name matches a mine's district exactly (e.g. an
       air-quality station literally named "Dhanbad" matching mines whose
       district is Dhanbad). Only ~17 of 400 monitored cities happen to
       share a name with a mine district, but where they do, this is a
       real geographic link, not a guess.
     - STATE-LEVEL proxy (lower confidence, dampened risk_score): for
       mines in a breaching state whose district didn't get a direct city
       match. Still not mine-specific, but now clearly the fallback tier
       rather than the only tier.
   A mine gets at most one Environmental flag -- district-level match wins
   over state-level if both would apply. LIMITATION: still not true
   mine-to-station geocoding (no lat/long join is done); real coordinate-
   based matching would be a further improvement.

EXPLANATIONS
------------
ai_risk_flags.explanation is commented in schema.sql as "LLM-generated
summary". If GROQ_API_KEY is set, this script asks Groq to turn each mine's
raw stats into a short, readable explanation (model_used='groq'); if not,
it falls back to a deterministic templated sentence built from the same
numbers (model_used='rule-based') so the job still runs end-to-end without
any API key -- useful for local testing or if you haven't set up Groq yet.

RISK SCORE
----------
Each flag type has its own simple, explainable normalization into [0, 1] --
see the `score_*` functions below. These are intentionally simple ratios/
z-scores, not a trained model -- swap in something fancier once you have
enough real (non-synthetic) history to justify it.
"""

import os
import math
import pandas as pd
from supabase import create_client, Client
from credentials import get_supabase_credentials, get_groq_key


SUPABASE_URL, SUPABASE_KEY = get_supabase_credentials()
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

GROQ_API_KEY = get_groq_key(required=False)
# llama-3.3-70b-versatile was decommissioned by Groq on 2026-08-16; calls to
# it fail, and this job would silently fall back to rule-based sentences.
# Kept in step with backend/app.py.
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
groq_client = None
if GROQ_API_KEY:
    from groq import Groq
    groq_client = Groq(api_key=GROQ_API_KEY)

# CPCB National Ambient Air Quality Standards, annual average limits (ug/m3)
NAAQS_ANNUAL_LIMITS = {"pm10_annual_avg": 60, "pm25_annual_avg": 40, "so2_annual_avg": 50, "no2_annual_avg": 40}


OWN_FLAG_TYPES = ["Anomalous Accident Rate", "Recurring Violation", "Compliance Gap",
                  "Environmental Threshold Breach", "Operational Anomaly"]


def clamp01(x):
    return max(0.0, min(1.0, x))


def fetch_all(build, page_size=1000):
    """Every row of a query, page by page.

    PostgREST caps a response at 1,000 rows. compliance_tracking holds
    ~12,000, so the compliance-gap flag used to be computed from whichever
    1,000 rows came back first -- most mines were never scored at all.
    `build` returns a fresh query builder each time it is called.
    """
    out, page = [], 0
    while True:
        chunk = build().range(page * page_size, page * page_size + page_size - 1).execute().data or []
        out.extend(chunk)
        if len(chunk) < page_size:
            return out
        page += 1


# ------------------------------------------------------------
# Flag 1: Anomalous Accident Rate
# ------------------------------------------------------------
def compute_accident_rate_flags():
    rows = supabase.table("accidents").select("mine_id, severity, accident_count") \
        .eq("severity", "Fatal").not_.is_("mine_id", "null").execute().data
    if not rows:
        return []
    df = pd.DataFrame(rows)
    per_mine = df.groupby("mine_id")["accident_count"].sum()
    mean, std = per_mine.mean(), per_mine.std(ddof=0)
    if std == 0 or math.isnan(std):
        return []

    flags = []
    for mine_id, count in per_mine.items():
        z = (count - mean) / std
        if z > 1.0:
            flags.append({
                "mine_id": mine_id,
                "flag_type": "Anomalous Accident Rate",
                "risk_score": float(round(clamp01(z / 3), 2)),
                "stats": {"fatal_accident_count": int(count), "mine_mean": float(round(mean, 2)), "z_score": float(round(z, 2))},
            })
    return flags


# ------------------------------------------------------------
# Flag 2: Recurring Violation
# ------------------------------------------------------------
def compute_recurring_violation_flags():
    # Every state short of verified closure counts as unresolved -- a fix
    # recorded but not yet checked ("Action Taken") has not been shown to
    # work, and a "Reopened" finding has been shown NOT to.
    rows = fetch_all(lambda: supabase.table("geo_inspections").select(
        "mine_id, severity, corrective_action_status, reopened_count"
    ).in_("severity", ["High", "Critical"]).in_(
        "corrective_action_status", ["Open", "In Progress", "Action Taken", "Reopened", "Overdue"]))
    if not rows:
        return []
    df = pd.DataFrame(rows)
    df["reopened_count"] = df.get("reopened_count", 0).fillna(0)
    per_mine = df.groupby("mine_id").agg(count=("severity", "size"), reopened=("reopened_count", "sum"))

    flags = []
    for mine_id, r in per_mine.iterrows():
        if r["count"] >= 2 or r["reopened"] >= 1:
            flags.append({
                "mine_id": mine_id,
                "flag_type": "Recurring Violation",
                # A fix that failed verification is weighted like two more
                # open findings: the problem came back after being "solved".
                "risk_score": float(round(clamp01((r["count"] + 2 * r["reopened"]) / 5), 2)),
                "stats": {"unresolved_high_critical_findings": int(r["count"]),
                          "failed_verifications": int(r["reopened"])},
            })
    return flags


# ------------------------------------------------------------
# Flag 3: Compliance Gap
# ------------------------------------------------------------
def compute_compliance_gap_flags():
    """Mines whose overdue share is unusually high COMPARED WITH THEIR PEERS.

    The old rule -- more than 15% overdue, or 3+ overdue items -- was
    written when this job only ever saw the first 1,000 of ~12,000 rows.
    Scoring every mine against it flagged 386 of 459 mines, because the
    national overdue rate is itself above 15%. A flag on almost every mine
    tells nobody where to look. The test is now relative: an overdue ratio
    more than one standard deviation above the national mean, or above
    50% outright (half of a mine's statutory obligations late is serious
    whatever everyone else is doing).
    """
    rows = fetch_all(lambda: supabase.table("compliance_tracking").select("mine_id, status"))
    if not rows:
        return []
    df = pd.DataFrame(rows)
    df = df[df["status"] != "Not Applicable"]
    per_mine = df.groupby("mine_id")["status"].agg(
        total="size", overdue=lambda s: int((s == "Overdue").sum()))
    per_mine = per_mine[per_mine["total"] >= 5]           # too few items to judge
    per_mine["ratio"] = per_mine["overdue"] / per_mine["total"]
    mean, std = per_mine["ratio"].mean(), per_mine["ratio"].std(ddof=0)

    flags = []
    for mine_id, r in per_mine.iterrows():
        z = (r["ratio"] - mean) / std if std else 0.0
        if z > 1.0 or r["ratio"] > 0.5:
            flags.append({
                "mine_id": mine_id,
                "flag_type": "Compliance Gap",
                "risk_score": float(round(clamp01(r["ratio"] + 0.1 * max(0.0, z)), 2)),
                "stats": {"overdue_items": int(r["overdue"]), "total_applicable_items": int(r["total"]),
                          "overdue_ratio": round(float(r["ratio"]), 2),
                          "national_mean_ratio": round(float(mean), 2), "z_score": round(float(z), 2)},
            })
    return flags


# ------------------------------------------------------------
# Flag 4: Environmental Threshold Breach (district-level match, state-level fallback)
# ------------------------------------------------------------
def compute_environmental_breach_flags():
    mines = supabase.table("mines").select("mine_id, state, district").execute().data
    aq_rows = supabase.table("air_quality_records").select(
        "state, city_town, so2_annual_avg, no2_annual_avg, pm10_annual_avg, pm25_annual_avg"
    ).execute().data
    if not mines or not aq_rows:
        return []
    aq_df = pd.DataFrame(aq_rows)

    # breaches keyed by state, and separately by (state, city) for district matching
    breaches_by_state = {}
    breaches_by_state_city = {}
    for _, r in aq_df.iterrows():
        for col, limit in NAAQS_ANNUAL_LIMITS.items():
            val = r.get(col)
            if pd.notna(val) and val > limit:
                pollutant = col.replace("_annual_avg", "").upper()
                breaches_by_state.setdefault(r["state"], []).append((r["city_town"], pollutant, val, limit))
                breaches_by_state_city.setdefault((r["state"], str(r["city_town"]).strip().lower()), []).append(
                    (r["city_town"], pollutant, val, limit)
                )

    flags = []
    for mine in mines:
        state, district = mine["state"], mine["district"]
        district_key = (state, str(district).strip().lower()) if district else None
        district_breaches = breaches_by_state_city.get(district_key) if district_key else None

        if district_breaches:
            pollutants = sorted({b[1] for b in district_breaches})
            flags.append({
                "mine_id": mine["mine_id"],
                "flag_type": "Environmental Threshold Breach",
                "risk_score": float(round(clamp01(len(pollutants) / 4 + 0.15), 2)),  # boosted for higher confidence
                "stats": {
                    "match_level": "district",
                    "state": state,
                    "district": district,
                    "pollutants_breached": pollutants,
                    "note": f"air-quality station name matches this mine's district ({district}) directly",
                },
            })
            continue  # district-level match wins; don't also add a state-level flag

        state_breaches = breaches_by_state.get(state)
        if state_breaches:
            pollutants = sorted({b[1] for b in state_breaches})
            flags.append({
                "mine_id": mine["mine_id"],
                "flag_type": "Environmental Threshold Breach",
                "risk_score": float(round(clamp01(len(pollutants) / 4 * 0.7), 2)),  # dampened for lower confidence
                "stats": {
                    "match_level": "state",
                    "state": state,
                    "breaching_cities_sample": [b[0] for b in state_breaches[:3]],
                    "pollutants_breached": pollutants,
                    "note": "state-level proxy -- no monitored city matched this mine's district directly",
                },
            })
    return flags


# ------------------------------------------------------------
# Flag 5: Operational Anomaly
#
# Two signals from the field data, combined into one finding per mine:
#   * production days whose output sits more than 2.5 standard deviations
#     from that mine's own trailing 30-day pattern (production_anomaly_view)
#   * geo-tagged records -- inspections and attendance -- made outside the
#     mine's geo-fence, which means either the record was not made where it
#     claims, or the mine's coordinates are wrong. Both need a person.
# ------------------------------------------------------------
def compute_operational_anomaly_flags():
    since = (pd.Timestamp.today().normalize() - pd.Timedelta(days=30)).date().isoformat()
    per_mine = {}

    try:
        prod = fetch_all(lambda: supabase.table("production_anomaly_view").select(
            "mine_id, production_date, produced_t, z_score").eq("is_anomaly", True).gte("production_date", since))
    except Exception as e:
        print(f"  production_anomaly_view unavailable ({e}); run migration 07")
        prod = []
    for r in prod:
        m = per_mine.setdefault(r["mine_id"], {"anomalous_production_days": 0, "worst_z": 0.0,
                                               "records_outside_geofence": 0})
        m["anomalous_production_days"] += 1
        m["worst_z"] = max(m["worst_z"], abs(float(r["z_score"] or 0)))

    for table, cols, date_col in [
        ("geo_inspections", "mine_id, within_geofence", "timestamp"),
        ("attendance_checkins", "mine_id, check_in_within_geofence", "check_in_at"),
    ]:
        try:
            rows = fetch_all(lambda t=table, c=cols, d=date_col: supabase.table(t).select(c).gte(d, since))
        except Exception:
            rows = []
        for r in rows:
            outside = r.get("within_geofence") is False or r.get("check_in_within_geofence") is False
            if outside:
                m = per_mine.setdefault(r["mine_id"], {"anomalous_production_days": 0, "worst_z": 0.0,
                                                       "records_outside_geofence": 0})
                m["records_outside_geofence"] += 1

    flags = []
    for mine_id, st in per_mine.items():
        if st["anomalous_production_days"] >= 2 or st["records_outside_geofence"] >= 3:
            score = clamp01(0.2 * st["anomalous_production_days"] + 0.1 * st["records_outside_geofence"]
                            + 0.05 * st["worst_z"])
            flags.append({"mine_id": mine_id, "flag_type": "Operational Anomaly",
                          "risk_score": float(round(score, 2)),
                          "stats": {**st, "worst_z": round(st["worst_z"], 2), "window_days": 30}})
    return flags


# ------------------------------------------------------------
# Explanations
# ------------------------------------------------------------
def rule_based_explanation(flag):
    t, s = flag["flag_type"], flag["stats"]
    if t == "Anomalous Accident Rate":
        return (f"This mine recorded {s['fatal_accident_count']} fatal accident(s), "
                f"vs a {s['mine_mean']} average across mines with any recorded fatal accident "
                f"(z-score {s['z_score']}).")
    if t == "Recurring Violation":
        return (f"{s['unresolved_high_critical_findings']} High/Critical-severity field-inspection "
                f"findings remain Open or Overdue at this mine.")
    if t == "Compliance Gap":
        return (f"{s['overdue_items']} of {s['total_applicable_items']} applicable statutory "
                f"compliance items are Overdue ({int(s['overdue_ratio'] * 100)}%), against a national "
                f"average of {int(s.get('national_mean_ratio', 0) * 100)}%.")
    if t == "Environmental Threshold Breach":
        if s.get("match_level") == "district":
            return (f"This mine's district ({s['district']}, {s['state']}) has an air-quality monitoring "
                     f"station exceeding CPCB annual limits for {', '.join(s['pollutants_breached'])}.")
        return (f"{s['state']} has monitored cities (e.g. {', '.join(s['breaching_cities_sample'])}) "
                f"exceeding CPCB annual limits for {', '.join(s['pollutants_breached'])}. "
                f"State-level proxy, not a mine-specific reading.")
    if t == "Operational Anomaly":
        bits = []
        if s.get("anomalous_production_days"):
            bits.append(f"{s['anomalous_production_days']} day(s) of production far outside this mine's "
                        f"normal range (worst z-score {s['worst_z']})")
        if s.get("records_outside_geofence"):
            bits.append(f"{s['records_outside_geofence']} inspection/attendance record(s) geo-tagged "
                        f"outside the mine's boundary")
        return "In the last 30 days: " + "; ".join(bits) + ". Worth checking the records are genuine."
    return "Risk flag generated."


def groq_explanation(flag):
    """Best-effort: falls back to the rule-based sentence on any API error,
    so a Groq outage never blocks the job from finishing."""
    if not groq_client:
        return rule_based_explanation(flag), "rule-based"
    try:
        prompt = (
            f"Write ONE concise, plain-English sentence (max 30 words) explaining this coal-mine "
            f"safety/compliance risk flag to a non-technical manager. Flag type: {flag['flag_type']}. "
            f"Raw stats: {flag['stats']}. Do not invent numbers not given above."
        )
        resp = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            # gpt-oss is a reasoning model; too small a budget returns an
            # empty sentence, so leave room and fall back if it happens.
            max_tokens=400,
        )
        text = (resp.choices[0].message.content or "").strip()
        if not text:
            raise ValueError("empty completion")
        return text, "groq"
    except Exception as e:
        print(f"  Groq call failed ({e}), falling back to rule-based explanation")
        return rule_based_explanation(flag), "rule-based"


def main():
    print("Computing risk flags...")
    all_flags = (
        compute_accident_rate_flags()
        + compute_recurring_violation_flags()
        + compute_compliance_gap_flags()
        + compute_environmental_breach_flags()
        + compute_operational_anomaly_flags()
    )
    print(f"  {len(all_flags)} raw flags computed across all 5 flag types")

    rows = []
    for flag in all_flags:
        explanation, model_used = groq_explanation(flag)
        rows.append({
            "mine_id": flag["mine_id"],
            "flag_type": flag["flag_type"],
            "risk_score": flag["risk_score"],
            "explanation": explanation,
            "model_used": model_used,
            "reviewed": False,
        })

    # Re-running must not erase what mine officials said about these
    # findings.
    #
    # This used to delete every row and reinsert, which is fine for scores
    # and fatal for responses: a manager who had marked a finding
    # "Addressed" or "Disputed" would silently lose that, and so would the
    # regulator reading it. The response is the operator's side of the
    # record -- losing it is worse than carrying a stale score.
    #
    # Flags are matched on (mine_id, flag_type), which is what identifies
    # a finding: "GEVRA OC has a recurring-violation problem" is the same
    # finding this week as last, with a new number attached.
    existing = {}
    page = 0
    while True:
        # Only this job's own flag types. predictive_job.py writes
        # "Predicted Non-Compliance" flags; without this filter they would
        # be treated as stale here and deleted on every run.
        chunk = supabase.table("ai_risk_flags").select(
            "flag_id, mine_id, flag_type, response_status, response_note, "
            "responded_by, responded_at"
        ).in_("flag_type", OWN_FLAG_TYPES).range(page * 1000, page * 1000 + 999).execute().data or []
        for r in chunk:
            existing[(r["mine_id"], r["flag_type"])] = r
        if len(chunk) < 1000:
            break
        page += 1

    answered = {k: v for k, v in existing.items()
                if (v.get("response_status") or "Open") != "Open"}

    fresh_keys = {(r["mine_id"], r["flag_type"]) for r in rows}

    # Remove only the flags being replaced by a fresh score AND carrying no
    # response. An answered flag is updated in place instead, so its
    # response and its audit trail survive.
    to_delete = [v["flag_id"] for k, v in existing.items()
                 if k not in answered and k in fresh_keys]
    for i in range(0, len(to_delete), 200):
        supabase.table("ai_risk_flags").delete().in_(
            "flag_id", to_delete[i:i + 200]).execute()

    # Flags that no longer come out of the analytics and were never
    # answered are stale -- drop them so the list reflects current data.
    stale = [v["flag_id"] for k, v in existing.items()
             if k not in answered and k not in fresh_keys]
    for i in range(0, len(stale), 200):
        supabase.table("ai_risk_flags").delete().in_(
            "flag_id", stale[i:i + 200]).execute()

    to_insert, updated = [], 0
    for r in rows:
        key = (r["mine_id"], r["flag_type"])
        prior = answered.get(key)
        if prior:
            # Score and explanation refresh; the operator's answer stays.
            supabase.table("ai_risk_flags").update({
                "risk_score": r["risk_score"],
                "explanation": r["explanation"],
                "model_used": r["model_used"],
            }).eq("flag_id", prior["flag_id"]).execute()
            updated += 1
        else:
            to_insert.append(r)

    for i in range(0, len(to_insert), 500):
        supabase.table("ai_risk_flags").insert(to_insert[i:i + 500]).execute()

    print(f"Inserted {len(to_insert)} new flags into ai_risk_flags "
          f"({'groq' if groq_client else 'rule-based'} explanations)")
    if updated:
        print(f"Refreshed {updated} flags in place, keeping the mine's response")
    if stale:
        print(f"Removed {len(stale)} flags no longer supported by the data")

    if rows:
        df = pd.DataFrame(rows)
        print(df["flag_type"].value_counts())


if __name__ == "__main__":
    main()
