"""
Seeds demo data for the two workflow features added in
migration_02_workflow.sql:

  1. contractor_compliance -- statutory documents per contractor, with a
     realistic spread of valid / expiring / expired / missing, so the
     dashboard has something to show and the alerts engine has something
     to fire on.
  2. grievance workflow fields -- priorities, assignment and a few
     resolved cases, so the grievance list isn't uniformly "In Progress".

Run AFTER migration_02_workflow.sql:

    python seed_workflow_data.py

You'll be prompted for the Supabase URL and service_role key (hidden).
Safe to re-run: existing compliance documents are cleared for the
contractors it touches before reinserting, so you don't accumulate
duplicates.
"""

import random
import datetime as dt

from supabase import create_client
from credentials import get_supabase_credentials

SUPABASE_URL, SERVICE_KEY = get_supabase_credentials()
supabase = create_client(SUPABASE_URL, SERVICE_KEY)

TODAY = dt.date.today()

# The four documents that actually gate a contractor working on an Indian
# coal mine. Keeping the list short and real matters more than volume --
# a reviewer recognises these.
DOCUMENTS = [
    "Safety training certificate",
    "Workmen compensation insurance",
    "PF registration",
    "Contract labour licence",
]

# Deliberate spread so the dashboard shows all four states rather than a
# wall of green. Weights, not a fixed pattern, so it doesn't look staged.
OFFSET_CHOICES = [
    ("valid", (120, 400)),
    ("valid", (60, 300)),
    ("expiring", (3, 28)),
    ("expired", (-120, -2)),
    ("missing", None),
]


def pick_validity():
    kind, rng = random.choice(OFFSET_CHOICES)
    if kind == "missing":
        return None
    return TODAY + dt.timedelta(days=random.randint(*rng))


def seed_contractor_documents():
    contractors = supabase.table("contractors").select(
        "contractor_id, contractor_name"
    ).limit(200).execute().data or []
    if not contractors:
        print("! No contractors found. Run load_seed_data.py first.")
        return 0

    ids = [c["contractor_id"] for c in contractors]
    # Clear first so re-running doesn't stack duplicate documents.
    for cid in ids:
        supabase.table("contractor_compliance").delete().eq("contractor_id", cid).execute()

    rows = []
    for c in contractors:
        for doc in DOCUMENTS:
            valid_until = pick_validity()
            issued = (valid_until - dt.timedelta(days=365)) if valid_until else None
            rows.append({
                "contractor_id": c["contractor_id"],
                "document_type": doc,
                "reference_no": f"{doc.split()[0][:3].upper()}/{random.randint(10000, 99999)}",
                "issued_on": issued.isoformat() if issued else None,
                "valid_until": valid_until.isoformat() if valid_until else None,
                "remarks": None,
            })

    for i in range(0, len(rows), 200):
        supabase.table("contractor_compliance").insert(rows[i:i + 200]).execute()
    print(f"Inserted {len(rows)} compliance documents across {len(contractors)} contractors")
    return len(rows)


def seed_grievance_workflow():
    grievances = supabase.table("grievances").select(
        "grievance_id, date_filed, status, category"
    ).limit(200).execute().data or []
    if not grievances:
        print("! No grievances found. Run load_seed_data.py first.")
        return 0

    officials = supabase.table("user_profiles").select("profile_id").in_(
        "role", ["mine_official", "contractor_manager"]
    ).execute().data or []
    assignee = officials[0]["profile_id"] if officials else None

    # Safety and harassment cases carry a shorter deadline than a
    # transport complaint -- a flat SLA across every category would be
    # the wrong signal to put in front of a reviewer.
    urgent = {"Safety Equipment Shortage", "Harassment/Conduct", "Medical Facility"}

    updated = 0
    for g in grievances:
        filed = g.get("date_filed")
        if not filed:
            continue
        filed_date = dt.date.fromisoformat(str(filed)[:10])
        is_urgent = g.get("category") in urgent
        sla_days = 7 if is_urgent else 14

        patch = {
            "priority": "High" if is_urgent else random.choice(["Low", "Medium", "Medium"]),
            "due_by": (filed_date + dt.timedelta(days=sla_days)).isoformat(),
            "assigned_to": assignee,
        }

        # Give roughly a third of the older cases a genuine resolution, so
        # the list shows a workflow in motion rather than a static backlog.
        age = (TODAY - filed_date).days
        if age > 30 and random.random() < 0.35:
            resolved_on = filed_date + dt.timedelta(days=random.randint(2, sla_days + 6))
            patch.update({
                "status": "Resolved",
                "resolved_at": dt.datetime.combine(resolved_on, dt.time(11, 0)).isoformat(),
                "resolved_by": assignee,
                "days_to_resolve": (resolved_on - filed_date).days,
                "resolution_note": random.choice([
                    "Raised with the contractor; replacement equipment issued and verified on site.",
                    "Discussed with the shift supervisor. Roster corrected from the following week.",
                    "Payment released after reconciliation with the contractor's attendance record.",
                    "Medical room stock replenished and a monthly check added to the safety round.",
                    "Transport schedule revised after consultation with the workers' representative.",
                ]),
            })
        elif age > 45 and random.random() < 0.25:
            patch.update({
                "status": "Escalated",
                "escalated": True,
                "escalated_at": dt.datetime.combine(
                    filed_date + dt.timedelta(days=sla_days + 2), dt.time(10, 0)
                ).isoformat(),
            })

        supabase.table("grievances").update(patch).eq("grievance_id", g["grievance_id"]).execute()
        updated += 1

    print(f"Updated {updated} grievances with priority, deadline and workflow state")
    return updated


def main():
    print(f"Seeding workflow data into {SUPABASE_URL}\n")
    seed_contractor_documents()
    seed_grievance_workflow()

    # Report what the dashboards will now show, so a failed seed is
    # obvious immediately rather than at demo time.
    try:
        docs = supabase.table("contractor_compliance_view").select(
            "computed_status"
        ).limit(2000).execute().data or []
        counts = {}
        for d in docs:
            counts[d["computed_status"]] = counts.get(d["computed_status"], 0) + 1
        print("\nContractor documents by status:")
        for k in ("Valid", "Expiring", "Expired", "Missing"):
            print(f"  {k:<10} {counts.get(k, 0)}")
    except Exception as e:
        print(f"(could not read back the view: {e})")

    print("\nDone.")


if __name__ == "__main__":
    main()
