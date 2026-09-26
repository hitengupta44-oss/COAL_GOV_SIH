"""
Past occurrences of each statutory obligation -- the history that
"recurring compliance failure" is measured against.

WHY THIS EXISTS
---------------
seed_compliance_tracking.py created ONE occurrence per mine per obligation:
this cycle's. A weekly gas test or a monthly return recurs, though, and a
mine that files late every month looks exactly like a mine that was late
once unless the earlier periods are on record. Migration 10 makes
obligations roll forward from now on; this script fills in the recent past
so the dashboards and the risk engine have something to measure today.

Run once, after migration 10 and after seed_compliance_tracking.py:

    python seed_compliance_history.py

WHAT IT CREATES
---------------
For every obligation at every mine, the occurrences that fell due before
the current one, going back 6 months (8 weeks for weekly obligations). Each
past occurrence was either completed on time or completed late; none is
left open, so the dashboards' overdue counts do not change. Whether a
period was late follows the same per-mine "compliance health" used by the
original seed, plus a per-obligation difficulty, so a weak mine misses the
same hard obligations repeatedly -- the pattern the new flag looks for.

Every row carries remarks = 'Synthetic history (demo data)'. Re-running
adds nothing twice (one occurrence per obligation per due date).
"""

import datetime as dt
import random

from dateutil.relativedelta import relativedelta
from supabase import create_client

from credentials import get_supabase_credentials

MARK = "Synthetic history (demo data)"
TODAY = dt.date.today()
WINDOW_DAYS = 180
WEEKLY_WINDOW_DAYS = 56


def step(frequency):
    return {"Weekly": relativedelta(days=7), "Monthly": relativedelta(months=1),
            "Annual": relativedelta(years=1)}.get(frequency, relativedelta(days=90))


def health(mine_id):
    # Identical to seed_compliance_tracking.compliance_health_score, so a
    # mine's history agrees with its current record.
    return random.Random(f"health:{mine_id}").uniform(0.35, 1.0)


def fetch_all(sb, build):
    out, page = [], 0
    while True:
        chunk = build().range(page * 1000, page * 1000 + 999).execute().data or []
        out.extend(chunk)
        if len(chunk) < 1000:
            return out
        page += 1


def main():
    url, key = get_supabase_credentials()
    sb = create_client(url, key)

    if sb.table("compliance_tracking").select("tracking_id", count="exact").eq(
            "remarks", MARK).limit(1).execute().count:
        print("History already seeded -- nothing to do.")
        return

    items = {i["item_id"]: i for i in sb.table("statutory_compliance_items").select(
        "item_id, frequency").execute().data or []}
    current = fetch_all(sb, lambda: sb.table("compliance_tracking").select(
        "mine_id, item_id, due_date").not_.is_("due_date", "null").neq("status", "Not Applicable"))
    if not current:
        raise SystemExit("No compliance_tracking rows. Run seed_compliance_tracking.py first.")

    # The earliest occurrence on record per obligation; history goes before it.
    earliest = {}
    for r in current:
        k = (r["mine_id"], r["item_id"])
        d = dt.date.fromisoformat(r["due_date"])
        if k not in earliest or d < earliest[k]:
            earliest[k] = d

    difficulty = {iid: random.Random(f"difficulty:{iid}").uniform(0.5, 1.6) for iid in items}
    rows = []
    for (mine_id, item_id), first_due in earliest.items():
        freq = items.get(item_id, {}).get("frequency")
        window = WEEKLY_WINDOW_DAYS if freq == "Weekly" else WINDOW_DAYS
        miss_p = min(0.9, (1 - health(mine_id)) * 0.55 * difficulty.get(item_id, 1))
        rng = random.Random(f"history:{mine_id}:{item_id}")
        due = first_due - step(freq)
        while due >= TODAY - dt.timedelta(days=window):
            if rng.random() < miss_p:
                done = due + dt.timedelta(days=rng.randint(1, 20 if freq != "Weekly" else 4))
            else:
                done = due - dt.timedelta(days=rng.randint(0, 5))
            rows.append({"mine_id": mine_id, "item_id": item_id, "due_date": due.isoformat(),
                         "completed_date": min(done, TODAY).isoformat(), "status": "Completed",
                         "remarks": MARK})
            due = due - step(freq)

    print(f"Writing {len(rows):,} past occurrences for {len(earliest):,} obligations...")
    for i in range(0, len(rows), 500):
        sb.table("compliance_tracking").upsert(
            rows[i:i + 500], on_conflict="mine_id,item_id,due_date", ignore_duplicates=True).execute()
        if (i // 500) % 10 == 0:
            print(f"  {min(i + 500, len(rows)):,}/{len(rows):,}")
    late = sum(1 for r in rows if r["completed_date"] > r["due_date"])
    print(f"Done: {len(rows):,} occurrences, {late:,} of them completed late.")


if __name__ == "__main__":
    main()
