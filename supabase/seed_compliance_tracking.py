"""
Seed compliance_tracking -- links every mine to the statutory_compliance_items
that apply to it, with a plausible status/due_date. Run this AFTER
load_seed_data.py (needs mines + statutory_compliance_items to already exist).

WHY THIS SCRIPT EXISTS
-----------------------
The Manager dashboard (frontend/pages/dashboard/manager.js) already queries
compliance_tracking joined with statutory_compliance_items -- that frontend
code was already built. But nothing ever inserted rows into
compliance_tracking, so every mine manager currently sees "No compliance
items loaded for this mine yet." This script closes that gap, AND gives the
risk-scoring job (risk_scoring_job.py) real per-mine signal for its
"Compliance Gap" flag type -- without it, that flag type would never fire.

WHAT IT DOES
------------
For every mine, for every statutory_compliance_item whose applicable_mine_type
matches that mine's type (OC/UG/Mixed -> OC/UG/Both), creates one
compliance_tracking row with:
  - a due_date derived from the item's frequency (Annual/Monthly/Weekly/
    Event-based/Ongoing) relative to today
  - a status (Completed/Pending/Overdue/Not Applicable) drawn from a
    per-mine "compliance health" score -- NOT uniform random. Each mine gets
    a deterministic health score in [0.35, 1.0] (seeded from its mine_id, so
    reruns are stable), and mines with a lower health score get a higher
    chance of Overdue items. This creates realistic variation across mines
    instead of every mine looking equally (non-)compliant, which is what the
    risk-scoring job needs to actually differentiate high-risk mines.

This is clearly synthetic/illustrative data for demo purposes -- there's no
real inspection history behind these statuses. Replace with real
inspector/manager-submitted completions over time (the Manager dashboard
already has no write-path for this yet -- that's a good next addition).

    pip install -r requirements.txt
    python seed_compliance_tracking.py
"""

import os
import random
import datetime
import pandas as pd
from supabase import create_client, Client
from credentials import get_supabase_credentials


SUPABASE_URL, SUPABASE_KEY = get_supabase_credentials()
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

TODAY = datetime.date.today()

# Frequency -> (cycle length in days, how far into the current cycle a
# "Pending" item's due date sits, i.e. still ahead of today)
FREQUENCY_CYCLE_DAYS = {
    "Annual": 365,
    "Monthly": 30,
    "Weekly": 7,
    "Ongoing": 90,       # no fixed statutory cadence -- treated as a 90-day check-in
    "Event-based": 90,   # same -- these fire on events, but still need periodic review
}


def mine_type_matches(item_applicable_type: str, mine_type: str) -> bool:
    """'Both' items apply to every mine. 'OC'/'UG' items apply to mines of
    that type, AND to 'Mixed' mines (which run both kinds of workings)."""
    if item_applicable_type == "Both":
        return True
    if mine_type == "Mixed":
        return True
    return item_applicable_type == mine_type


def compliance_health_score(mine_id: str) -> float:
    """Deterministic per-mine 'how on-top-of-compliance is this mine' score
    in [0.35, 1.0], seeded from the mine_id so it's stable across reruns."""
    rng = random.Random(f"health:{mine_id}")
    return rng.uniform(0.35, 1.0)


def pick_status(rng: random.Random, health: float, frequency: str):
    """Returns (status, due_date, completed_date). Lower health -> more
    Overdue. Event-based/Ongoing items skew towards Pending/Completed since
    'Overdue' is a less natural fit for something without a hard legal
    deadline."""
    cycle_days = FREQUENCY_CYCLE_DAYS.get(frequency, 90)

    if frequency in ("Event-based", "Ongoing"):
        roll = rng.random()
        if roll < health * 0.7:
            status = "Completed"
        elif roll < health * 0.7 + 0.25:
            status = "Pending"
        else:
            status = "Overdue"
    else:
        overdue_chance = (1 - health) * 0.5       # up to ~32% for the least-compliant mines
        completed_chance = health * 0.75
        roll = rng.random()
        if roll < completed_chance:
            status = "Completed"
        elif roll < completed_chance + overdue_chance:
            status = "Overdue"
        else:
            status = "Pending"

    if status == "Completed":
        due_date = TODAY - datetime.timedelta(days=rng.randint(0, cycle_days))
        completed_date = due_date - datetime.timedelta(days=rng.randint(0, 10))
        return status, due_date.isoformat(), completed_date.isoformat()
    elif status == "Overdue":
        due_date = TODAY - datetime.timedelta(days=rng.randint(1, cycle_days))
        return status, due_date.isoformat(), None
    else:  # Pending
        due_date = TODAY + datetime.timedelta(days=rng.randint(1, cycle_days))
        return status, due_date.isoformat(), None


def main():
    mines = supabase.table("mines").select("mine_id, mine_type").execute().data
    items = supabase.table("statutory_compliance_items").select(
        "item_id, applicable_mine_type, frequency"
    ).execute().data

    if not mines:
        print("No mines found -- run load_seed_data.py first.")
        return
    if not items:
        print("No statutory_compliance_items found -- run load_seed_data.py first.")
        return

    existing = supabase.table("compliance_tracking").select("tracking_id", count="exact").execute()
    if existing.count:
        print(f"compliance_tracking already has {existing.count} rows -- skipping to avoid duplicates. "
              f"Delete existing rows first if you want to reseed.")
        return

    rows = []
    for mine in mines:
        health = compliance_health_score(mine["mine_id"])
        mine_rng = random.Random(f"rows:{mine['mine_id']}")
        for item in items:
            if not mine_type_matches(item["applicable_mine_type"], mine["mine_type"]):
                continue
            status, due_date, completed_date = pick_status(mine_rng, health, item["frequency"])
            rows.append({
                "mine_id": mine["mine_id"],
                "item_id": item["item_id"],
                "due_date": due_date,
                "completed_date": completed_date,
                "status": status,
                "remarks": None,
            })

    for i in range(0, len(rows), 500):
        supabase.table("compliance_tracking").insert(rows[i:i + 500]).execute()

    print(f"Seeded {len(rows)} compliance_tracking rows across {len(mines)} mines.")
    df = pd.DataFrame(rows)
    print(df["status"].value_counts())


if __name__ == "__main__":
    main()
