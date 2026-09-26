"""
Demo data for the field-operations modules added in migrations 07-08:
production, environmental readings, attendance, incidents, corrective
actions in every workflow state, and statutory returns.

Run AFTER seed_demo_users.py (it attaches data to the demo accounts' mine)
and BEFORE risk_scoring_job.py / predictive_job.py (which read it):

    python seed_field_operations.py

Every row is marked is_synthetic = true where the table has that column.
Re-running adds nothing twice: each section checks for existing demo rows.

WHAT A JUDGE WILL SEE
  * mine official  -- 60 days of production with two anomalous days, weekly
                      air/water/noise readings with a few breaches, a
                      serious-injury incident awaiting its DGMS notice, a
                      draft return ready to submit, findings to act on
  * inspector      -- two fixes waiting to be verified
  * corporate      -- a submitted return waiting for approval
  * regulator      -- an approved return, filed
  * worker         -- two weeks of check-ins, one outside the geo-fence
"""

import datetime as dt
import random

from supabase import create_client

from credentials import get_supabase_credentials

url, key = get_supabase_credentials()
sb = create_client(url, key)
rng = random.Random(2026)
TODAY = dt.date.today()
NOW = dt.datetime.now(dt.timezone.utc)
EXTRA_MINES = 15   # other mines given production/env data so oversight views aren't one-mine


def demo_people():
    rows = sb.table("user_profiles").select("profile_id, role, mine_id, email").like(
        "email", "%@coaldemo.in").execute().data or []
    people = {r["role"]: r for r in rows}
    mine = next((r["mine_id"] for r in rows if r.get("mine_id")), None)
    if not mine:
        raise SystemExit("No demo users with a mine found. Run seed_demo_users.py first.")
    return people, mine


def mine_row(mine_id):
    return sb.table("mines").select("mine_id, mine_name, latitude, longitude").eq(
        "mine_id", mine_id).single().execute().data


def jitter(lat, lon, km):
    """A point roughly `km` from (lat, lon)."""
    d = km / 111.0
    return round(float(lat) + rng.uniform(-d, d), 6), round(float(lon) + rng.uniform(-d, d), 6)


def seed_production(mines):
    if sb.table("mine_production_daily").select("record_id", count="exact").eq(
            "is_synthetic", True).limit(1).execute().count:
        print("production: already seeded")
        return
    rows = []
    for m in mines:
        base = rng.uniform(1500, 9000)
        odd = {rng.randint(3, 50), rng.randint(3, 50)}          # two anomalous days per mine
        for d in range(60, -1, -1):
            day = TODAY - dt.timedelta(days=d)
            for shift, share in (("A", 0.38), ("B", 0.35), ("C", 0.27)):
                target = round(base * share, 1)
                produced = target * rng.uniform(0.85, 1.08)
                if d in odd:
                    produced *= rng.choice([0.15, 2.4])
                rows.append({
                    "mine_id": m["mine_id"], "production_date": day.isoformat(), "shift": shift,
                    "coal_produced_t": round(produced, 1),
                    "coal_dispatched_t": round(produced * rng.uniform(0.8, 1.0), 1),
                    "overburden_removed_m3": round(produced * rng.uniform(2.5, 4.5), 1),
                    "target_t": target, "is_synthetic": True,
                })
    for i in range(0, len(rows), 500):
        sb.table("mine_production_daily").insert(rows[i:i + 500]).execute()
    print(f"production: {len(rows)} shift records across {len(mines)} mines")


def seed_environment(mines):
    if sb.table("env_readings").select("reading_id", count="exact").eq(
            "is_synthetic", True).limit(1).execute().count:
        print("environment: already seeded")
        return
    typical = {"PM10": (70, 25), "PM2.5": (38, 12), "SO2": (22, 8), "NO2": (30, 10),
               "Noise (day)": (66, 5), "Discharge pH": (7.4, 0.6), "Discharge TSS": (55, 25)}
    rows = []
    for m in mines:
        for w in range(8, -1, -1):
            day = TODAY - dt.timedelta(days=7 * w + rng.randint(0, 2))
            for param, (mu, sd) in typical.items():
                rows.append({"mine_id": m["mine_id"], "reading_date": day.isoformat(), "parameter": param,
                             "value": round(max(0.1, rng.gauss(mu, sd)), 1),
                             "station_label": rng.choice(["Haul road", "CHP", "Township", "Mine discharge"]),
                             "is_synthetic": True})
    # The trigger decides which readings breach the limit and raises alerts.
    for i in range(0, len(rows), 500):
        sb.table("env_readings").insert(rows[i:i + 500]).execute()
    print(f"environment: {len(rows)} readings")


def seed_attendance(people, mine):
    if sb.table("attendance_checkins").select("checkin_id", count="exact").eq(
            "is_synthetic", True).limit(1).execute().count:
        print("attendance: already seeded")
        return
    if not mine.get("latitude"):
        print("attendance: demo mine has no coordinates, skipped")
        return
    rows = []
    for role in ("worker", "inspector", "contractor_manager", "mine_official"):
        p = people.get(role)
        if not p:
            continue
        for d in range(14, 0, -1):
            start = dt.datetime.combine(TODAY - dt.timedelta(days=d), dt.time(0, 45),
                                        tzinfo=dt.timezone.utc) + dt.timedelta(minutes=rng.randint(0, 40))
            far = (role == "worker" and d == 4)                  # one exception to find
            lat, lon = jitter(mine["latitude"], mine["longitude"], 60 if far else 1)
            olat, olon = jitter(mine["latitude"], mine["longitude"], 1)
            rows.append({"profile_id": p["profile_id"], "mine_id": mine["mine_id"],
                         "check_in_at": start.isoformat(),
                         "check_out_at": (start + dt.timedelta(hours=8, minutes=rng.randint(0, 50))).isoformat(),
                         "check_in_lat": lat, "check_in_lon": lon,
                         "check_out_lat": olat, "check_out_lon": olon, "is_synthetic": True})
    sb.table("attendance_checkins").insert(rows).execute()
    print(f"attendance: {len(rows)} check-ins")


def seed_incidents(people, mine):
    if sb.table("incidents").select("incident_id", count="exact").eq(
            "is_synthetic", True).limit(1).execute().count:
        print("incidents: already seeded")
        return
    lat, lon = jitter(mine["latitude"] or 23.7, mine["longitude"] or 86.4, 1)
    rep = (people.get("worker") or {}).get("profile_id")
    sb.table("incidents").insert([
        {"mine_id": mine["mine_id"], "reported_by": rep, "is_synthetic": True,
         "occurred_at": (NOW - dt.timedelta(hours=6)).isoformat(), "incident_type": "Serious Injury",
         "persons_injured": 1, "latitude": lat, "longitude": lon, "location_description": "Haul road bend, bench 4",
         "description": "Dumper reversing struck a helper; reversing alarm not audible.",
         "immediate_action": "First aid, shifted to area hospital; dumper withdrawn from service."},
        {"mine_id": mine["mine_id"], "reported_by": rep, "is_synthetic": True,
         "occurred_at": (NOW - dt.timedelta(days=9)).isoformat(), "incident_type": "Near Miss",
         "latitude": lat, "longitude": lon, "location_description": "Face 2",
         "description": "Loose overhang fell after blasting close to where two workers had been standing.",
         "immediate_action": "Area cordoned, dressing done before resuming."},
    ]).execute()
    print("incidents: 2 at the demo mine (alerts raised by the database)")


def seed_actions(people, mine):
    """Put a few of the demo mine's findings into every workflow state."""
    if sb.table("geo_inspections").select("inspection_id", count="exact").eq(
            "mine_id", mine["mine_id"]).eq("corrective_action_status", "Action Taken").limit(1).execute().count:
        print("corrective actions: already seeded")
        return
    rows = sb.table("geo_inspections").select("inspection_id, severity, corrective_action_status").eq(
        "mine_id", mine["mine_id"]).neq("corrective_action_status", "Closed").limit(10).execute().data or []
    official = (people.get("mine_official") or {}).get("profile_id")
    inspector = (people.get("inspector") or {}).get("profile_id")
    if not rows:
        lat, lon = jitter(mine["latitude"] or 23.7, mine["longitude"] or 86.4, 1)
        for sev, obs in (("High", "Slope Stability"), ("Critical", "Electrical Safety"),
                         ("Medium", "Housekeeping"), ("High", "Ventilation Inspection")):
            sb.table("geo_inspections").insert({
                "mine_id": mine["mine_id"], "inspector_id": inspector, "timestamp": (NOW - dt.timedelta(days=5)).isoformat(),
                "latitude": lat, "longitude": lon, "observation_type": obs, "severity": sev,
                "notes": f"{obs} finding recorded during routine inspection.", "is_synthetic": True}).execute()
        rows = sb.table("geo_inspections").select("inspection_id, severity, corrective_action_status").eq(
            "mine_id", mine["mine_id"]).neq("corrective_action_status", "Closed").limit(10).execute().data or []
    plan = ["Action Taken", "Action Taken", "In Progress"]
    done = 0
    for row, state in zip(rows, plan):
        upd = {"corrective_action_status": state}
        if state == "Action Taken":
            upd.update({"action_taken": "Defect rectified; area re-inspected by the shift in-charge.",
                        "action_submitted_by": official, "action_submitted_at": NOW.isoformat()})
        sb.table("geo_inspections").update(upd).eq("inspection_id", row["inspection_id"]).execute()
        done += 1
    print(f"corrective actions: {done} findings moved along the workflow")


def seed_returns(people, mine):
    if sb.table("statutory_returns").select("return_id", count="exact").eq(
            "mine_id", mine["mine_id"]).limit(1).execute().count:
        print("returns: already seeded")
        return
    first_this = TODAY.replace(day=1)
    last_month_end = first_this - dt.timedelta(days=1)
    last_month = last_month_end.replace(day=1)
    two_back_end = last_month - dt.timedelta(days=1)
    two_back = two_back_end.replace(day=1)
    official = (people.get("mine_official") or {}).get("profile_id")
    corporate = (people.get("corporate_admin") or {}).get("profile_id")
    base = {"mine_id": mine["mine_id"], "prepared_by": official}
    sb.table("statutory_returns").insert([
        {**base, "return_type": "Monthly Safety & Compliance Return", "period_start": two_back.isoformat(),
         "period_end": two_back_end.isoformat(), "status": "Approved", "submitted_by": official,
         "submitted_at": NOW.isoformat(), "reviewed_by": corporate, "reviewed_at": NOW.isoformat()},
        {**base, "return_type": "Monthly Safety & Compliance Return", "period_start": last_month.isoformat(),
         "period_end": last_month_end.isoformat(), "status": "Submitted", "submitted_by": official,
         "submitted_at": NOW.isoformat(), "remarks": "Two High findings carried forward; fixes in progress."},
        {**base, "return_type": "Monthly Production Return", "period_start": last_month.isoformat(),
         "period_end": last_month_end.isoformat(), "status": "Draft"},
    ]).execute()
    print("returns: approved, submitted and draft examples")


def main():
    people, mine_id = demo_people()
    mine = mine_row(mine_id)
    print(f"Demo mine: {mine['mine_name']}\n")
    others = sb.table("mines").select("mine_id, mine_name, latitude, longitude").neq(
        "mine_id", mine_id).not_.is_("latitude", "null").limit(200).execute().data or []
    sample = [mine] + rng.sample(others, min(EXTRA_MINES, len(others)))
    seed_production(sample)
    seed_environment(sample)
    seed_attendance(people, mine)
    seed_incidents(people, mine)
    seed_actions(people, mine)
    seed_returns(people, mine)
    print("\nDone. Now run risk_scoring_job.py, predictive_job.py and alerts_engine.py.")


if __name__ == "__main__":
    main()
