"""
Demo dispatches and grade checks for the Dispatch & coal grade page
(migration 15).

Run once, after migration_15_grade_verification.sql:

    python seed_dispatches.py

Safe to run again: it adds nothing if demo dispatches already exist.

WHAT IT CREATES (all marked is_synthetic = true)
  * 45 days of dispatches -- road trucks and rail rakes -- for the demo
    mine and five large mines, sized from each mine's real 2019-20 output.
    Where a mine has an OFFICIAL declared grade (load_declared_grades.py,
    e.g. MCL's 2025-26 declaration), dispatches are declared at that grade,
    with an occasional one declared a grade higher so the "declared above
    the official grade" flag can be shown; otherwise a grade typical of the
    coalfield is used.
  * Grade checks on about a third of them, with GCV values around the
    declared grade: most match, a few are better, and a handful show
    slippage of one or two grades, so the alerts, the per-mine summary and
    the report can be shown. Two are "photo screening only" awaiting a lab
    test.
  * Seeded checks carry a placeholder image ("Demo record -- no photo")
    instead of a real photograph, so nothing pretends to be real evidence.
    Real checks made in the app use the inspector's own photos.
"""

import datetime as dt
import io
import random

from supabase import create_client

from credentials import get_supabase_credentials

url, key = get_supabase_credentials()
sb = create_client(url, key)
rng = random.Random(1509)
TODAY = dt.date.today()

# name, typical declared grades, a few consignees (illustrative)
MINES = [
    (None,        ["G9", "G10", "G11"], ["NTPC Ramagundam", "TSGENCO Kothagudem", "Singareni TPP"]),   # demo mine
    ("KHADIA",    ["G10", "G11", "G12"], ["NTPC Singrauli", "NTPC Rihand", "UPRVUNL Anpara"]),
    ("GEVRA OC",  ["G11", "G12"],        ["NTPC Korba", "CSPGCL Korba West", "NTPC Sipat"]),
    ("LAKHANPUR", ["G14"],               ["OPGC Jharsuguda", "NTPC Darlipali", "Vedanta Jharsuguda"]),
    ("KULDA",     ["G13"],               ["NTPC Talcher", "NTPC Darlipali", "OPGC Jharsuguda"]),
    ("KUSMUNDA",  ["G11", "G12"],        ["NTPC Korba", "MAHAGENCO Chandrapur", "NTPC Lara"]),
]
BANDS = {f"G{i}": (7001 if i == 1 else 7000 - 300 * (i - 1) + 1, None if i == 1 else 7000 - 300 * (i - 2)) for i in range(1, 18)}


def placeholder_png():
    """A plain grey image saying it is not a photograph."""
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (800, 600), (64, 70, 78))
    d = ImageDraw.Draw(im)
    d.text((40, 270), "Demo record - no photo.", fill=(230, 230, 230))
    d.text((40, 300), "Real grade checks carry the inspector's photos.", fill=(200, 200, 200))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def gcv_for(grade, shift):
    """A GCV inside the band `shift` grades away from `grade` (+ = worse)."""
    i = int(grade[1:]) + shift
    i = min(17, max(1, i))
    lo, hi = BANDS[f"G{i}"]
    hi = hi or lo + 250
    return rng.randint(lo + 20, hi - 20)


def main():
    if sb.table("coal_dispatches").select("dispatch_id", count="exact").eq(
            "is_synthetic", True).limit(1).execute().count:
        print("Demo dispatches already exist -- nothing to do.")
        return

    demo = sb.table("user_profiles").select("mine_id, profile_id, role").like(
        "email", "%@coaldemo.in").execute().data or []
    demo_mine = next((r["mine_id"] for r in demo if r.get("mine_id")), None)
    inspector = next((r["profile_id"] for r in demo if r["role"] == "inspector"), None)
    if not demo_mine:
        raise SystemExit("No demo mine found. Run seed_demo_users.py first.")

    mines = []
    for name, grades, consignees in MINES:
        if name is None:
            m = sb.table("mines").select("mine_id, mine_name, production_2019_20_mt").eq(
                "mine_id", demo_mine).single().execute().data
        else:
            rows = sb.table("mines").select("mine_id, mine_name, production_2019_20_mt").eq(
                "mine_name", name).limit(1).execute().data
            if not rows:
                print(f"  ! {name} not in the mines table, skipped")
                continue
            m = rows[0]
        try:
            og = sb.rpc("official_grade_of", {"p_mine": m["mine_id"]}).execute().data or []
        except Exception:
            og = []
        m["official"] = og[0]["grade"] if og else None
        mines.append((m, [m["official"]] if m["official"] else grades, consignees))

    # Placeholder image, one per mine (evidence paths are per mine).
    img = placeholder_png()
    placeholder = {}
    for m, _, _ in mines:
        path = f"{m['mine_id']}/grade-checks/demo-placeholder.png"
        try:
            sb.storage.from_("evidence").upload(path, img, {"content-type": "image/png", "upsert": "true"})
        except Exception as e:
            print(f"  ! placeholder upload for {m['mine_name']}: {e}")
        placeholder[m["mine_id"]] = path

    dispatches = []
    for m, grades, consignees in mines:
        annual = float(m.get("production_2019_20_mt") or 0)
        daily = annual * 1e6 / 365 if annual >= 0.1 else 2500
        for d in range(45, 0, -1):
            day = TODAY - dt.timedelta(days=d)
            for _ in range(rng.randint(1, 3)):
                rail = daily > 8000 and rng.random() < 0.6
                qty = round(rng.uniform(3600, 4000), 1) if rail else round(rng.uniform(18, 32), 1)
                ref = (f"RK-{day:%m%d}-{rng.randint(100, 999)}" if rail
                       else f"{rng.choice(['JH', 'CG', 'OD', 'MP', 'TS'])}{rng.randint(1, 40):02d}"
                            f"{rng.choice('ABCDEFGH')}{rng.choice('ABCDEFGH')}{rng.randint(1000, 9999)}")
                dispatches.append({
                    "mine_id": m["mine_id"], "dispatch_date": day.isoformat(),
                    "mode": "Rail" if rail else "Road", "vehicle_ref": ref,
                    "consignee": rng.choice(consignees), "quantity_t": qty,
                    "declared_grade": (f"G{int(grades[0][1:]) - 1}" if m.get("official") and rng.random() < 0.04
                                       else rng.choice(grades)),
                    "is_synthetic": True,
                })
    saved = []
    for i in range(0, len(dispatches), 500):
        saved += sb.table("coal_dispatches").insert(dispatches[i:i + 500]).execute().data or []
    print(f"Dispatches: {len(saved)} across {len(mines)} mines")

    checks, pending_lab = [], 0
    for dsp in saved:
        if rng.random() > 0.33:
            continue
        roll = rng.random()
        shift = 0 if roll < 0.62 else -1 if roll < 0.74 else 1 if roll < 0.92 else 2
        visual_only = pending_lab < 2 and rng.random() < 0.05
        method = None if visual_only else rng.choice(["Field test", "Laboratory (third party)", "Laboratory (mine)"])
        gcv = None if visual_only else gcv_for(dsp["declared_grade"], shift)
        checked = dt.datetime.fromisoformat(dsp["dispatch_date"]).replace(
            hour=rng.randint(6, 18), minute=rng.randint(0, 59), tzinfo=dt.timezone.utc)
        row = {
            "dispatch_id": dsp["dispatch_id"], "inspector_id": inspector if dsp["mine_id"] == demo_mine else None,
            "checked_at": checked.isoformat(), "photo_paths": [placeholder[dsp["mine_id"]]],
            "test_method": method, "sample_ref": None if visual_only else f"S/{dsp['dispatch_date'][5:].replace('-', '')}/{rng.randint(10, 99)}",
            "gcv_kcal_kg": gcv,
            "ash_pct": None if visual_only else round(rng.uniform(28, 45) + 3 * max(shift, 0), 1),
            "moisture_pct": None if visual_only else round(rng.uniform(6, 12), 1),
            "notes": "Synthetic demo check.", "is_synthetic": True,
        }
        if visual_only:
            pending_lab += 1
            row["ai_assessment"] = {
                "is_coal_load": "yes", "stone_shale": "heavy", "fines": "high", "surface_moisture": "damp",
                "lustre": "dull", "foreign_material": ["shale bands"], "consistent_with_declared": "no",
                "estimated_grade_range": "unknown", "confidence": "medium",
                "summary": "Demo record: heavy shale and a dull surface suggest quality below the declared grade.",
            }
            row["ai_model"] = "demo (not a real screening)"
            row["ai_at"] = checked.isoformat()
        checks.append(row)
    for i in range(0, len(checks), 300):
        sb.table("grade_checks").insert(checks[i:i + 300]).execute()
    res = sb.table("grade_checks").select("verdict").eq("is_synthetic", True).execute().data or []
    tally = {}
    for r in res:
        tally[r["verdict"]] = tally.get(r["verdict"], 0) + 1
    print(f"Grade checks: {len(res)} -> " + ", ".join(f"{k}: {v}" for k, v in sorted(tally.items())))


if __name__ == "__main__":
    main()
