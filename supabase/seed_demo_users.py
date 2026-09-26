"""
Creates the demo/mock user accounts used for the judge walkthrough.

WHY THIS IS A SCRIPT AND NOT PLAIN SQL
--------------------------------------
You cannot create a working login by INSERTing into auth.users by hand.
Supabase Auth owns that table and expects a specific password-hash format,
identity rows, and confirmation state -- a hand-written INSERT produces a
row that looks fine in the table editor but silently fails at login. The
supported path is the Admin API (service_role key), which is what this
script uses via `supabase.auth.admin.create_user`.

Each demo user is created with email_confirm=True so there's no
confirmation email step in the middle of your demo, then given a matching
`user_profiles` row carrying their role and mine assignment.

USAGE
-----
    pip install -r requirements.txt
    python seed_demo_users.py

You'll be prompted for your Supabase URL and service_role key (the key
input is hidden). Export them as env vars first if you'd rather skip the
prompts. No .env file is needed or created.

Safe to re-run: if a demo user already exists, the script updates their
profile row instead of erroring out.

SECURITY: these are deliberately weak, publicly-known demo passwords. They
exist so judges can log in as each role in seconds. Do not reuse this
script, or these accounts, against a database holding real data.
"""

import os
import sys

from supabase import create_client

from credentials import get_supabase_credentials

SUPABASE_URL, SERVICE_KEY = get_supabase_credentials()

supabase = create_client(SUPABASE_URL, SERVICE_KEY)

DEMO_PASSWORD = "CoalDemo#2026"

# Which mine the mine-scoped demo users are attached to. Substring match,
# case-insensitive; falls back to the first mine found.
DEMO_MINE_NAME = os.environ.get("DEMO_MINE_NAME", "")

# One account per role, so every dashboard can be demoed.
# mine_name is resolved to a real mine_id below -- leave it None for roles
# that aren't tied to a single mine (corporate/regulator/admin).
#
# NOTE: the mines table has no "mine_code" column (its columns are
# mine_id/mine_name/state/district/...), so demo users are attached to
# whichever real mine the seed data loaded. DEMO_MINE_NAME below is
# matched case-insensitively as a substring; if it isn't found, the script
# falls back to the first mine in the table so mine-scoped demos still
# work rather than silently ending up with a null mine_id.
DEMO_USERS = [
    {
        "email": "admin@coaldemo.in",
        "full_name": "Asha Menon",
        "role": "admin",
        "mine_scoped": False,
        "blurb": "Full access. Manages users and roles.",
    },
    {
        "email": "corporate@coaldemo.in",
        "full_name": "Rajiv Khanna",
        "role": "corporate_admin",
        "mine_scoped": False,
        "blurb": "Cross-subsidiary KPIs, production and risk rollups.",
    },
    {
        "email": "regulator@coaldemo.in",
        "full_name": "Dr. Neelam Rao",
        "role": "regulator",
        "mine_scoped": False,
        "blurb": "Read-only oversight across all mines (DGMS-style).",
    },
    {
        "email": "manager@coaldemo.in",
        "full_name": "Sunil Bhattacharya",
        "role": "mine_official",
        "mine_scoped": True,
        "blurb": "Runs one mine. Can update compliance items.",
    },
    {
        "email": "inspector@coaldemo.in",
        "full_name": "Priya Nair",
        "role": "inspector",
        "mine_scoped": True,
        "blurb": "Files geo-tagged field inspections.",
    },
    {
        "email": "contractor@coaldemo.in",
        "full_name": "Imran Sheikh",
        "role": "contractor_manager",
        "mine_scoped": True,
        "blurb": "Contractor workforce and safety compliance.",
    },
    {
        "email": "worker@coaldemo.in",
        "full_name": "Mahesh Kumar",
        "role": "worker",
        "mine_scoped": True,
        "blurb": "Limited view: own mine's safety info and alerts.",
    },
]


_mine_cache = {}


def resolve_demo_mine_id():
    """Pick one real mine for the mine-scoped demo accounts.

    Cached so we only hit the table once. Returns None (with a warning) if
    the mines table is empty, which means load_seed_data.py hasn't run yet.
    """
    if "id" in _mine_cache:
        return _mine_cache["id"]

    mine_id = None
    try:
        if DEMO_MINE_NAME:
            rows = supabase.table("mines").select("mine_id, mine_name").ilike(
                "mine_name", f"%{DEMO_MINE_NAME}%"
            ).limit(1).execute().data
            if rows:
                mine_id = rows[0]["mine_id"]
                print(f"  demo mine: {rows[0]['mine_name']}")

        if mine_id is None:
            rows = supabase.table("mines").select("mine_id, mine_name").order(
                "mine_name"
            ).limit(1).execute().data
            if rows:
                mine_id = rows[0]["mine_id"]
                print(f"  demo mine (first available): {rows[0]['mine_name']}")
            else:
                print("  ! mines table is empty -- mine-scoped users will have "
                      "mine_id=null. Run load_seed_data.py first, then re-run "
                      "this script to attach them.")
    except Exception as e:
        print(f"  ! could not read mines table: {e}")

    _mine_cache["id"] = mine_id
    return mine_id


def find_existing_auth_user(email):
    """The admin API has no direct get-by-email, so page through users."""
    try:
        page = 1
        while True:
            users = supabase.auth.admin.list_users(page=page, per_page=200)
            if not users:
                return None
            for u in users:
                if (u.email or "").lower() == email.lower():
                    return u
            if len(users) < 200:
                return None
            page += 1
    except Exception as e:
        print(f"  ! could not list users: {e}")
        return None


def main():
    print(f"Seeding {len(DEMO_USERS)} demo users into {SUPABASE_URL}\n")
    created, updated = 0, 0

    for spec in DEMO_USERS:
        email = spec["email"]
        print(f"- {email}  ({spec['role']})")

        auth_user = find_existing_auth_user(email)
        if auth_user:
            uid = auth_user.id
            print("  auth user already exists, reusing")
        else:
            try:
                res = supabase.auth.admin.create_user({
                    "email": email,
                    "password": DEMO_PASSWORD,
                    "email_confirm": True,   # skip the confirmation email
                    "user_metadata": {"full_name": spec["full_name"]},
                })
                uid = res.user.id
                print("  auth user created")
            except Exception as e:
                print(f"  ! failed to create auth user: {e}")
                continue

        row = {
            "auth_uid": uid,
            "email": email,
            "full_name": spec["full_name"],
            "role": spec["role"],
            "mine_id": resolve_demo_mine_id() if spec["mine_scoped"] else None,
        }

        existing = supabase.table("user_profiles").select("profile_id").eq("auth_uid", uid).execute().data
        try:
            if existing:
                supabase.table("user_profiles").update(row).eq("auth_uid", uid).execute()
                print("  profile updated")
                updated += 1
            else:
                supabase.table("user_profiles").insert(row).execute()
                print("  profile created")
                created += 1
        except Exception as e:
            print(f"  ! profile write failed: {e}")

    print(f"\nDone. {created} profiles created, {updated} updated.")
    print("\n" + "=" * 62)
    print("DEMO LOGINS  (password for all accounts below)")
    print(f"  password: {DEMO_PASSWORD}")
    print("=" * 62)
    for s in DEMO_USERS:
        print(f"  {s['email']:<28} {s['role']:<20} {s['blurb']}")
    print("=" * 62)


if __name__ == "__main__":
    main()
