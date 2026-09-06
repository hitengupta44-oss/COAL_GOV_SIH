# Coal Mining Smart Governance Platform
SIH 2026 — Problem Statement 26024

## Stack
- **Auth:** Supabase Authentication
- **Database:** Supabase (Postgres + PostGIS)
- **Backend:** Gradio app on Hugging Face Spaces (doubles as REST API)
- **Frontend:** Next.js on Vercel
- **AI/LLM:** Groq API (base model now, fine-tune on your DGMS + compliance data later)

## Folder structure
```
coal-governance-platform/
├── supabase/
│   ├── schema.sql          # run this first in Supabase SQL Editor
│   └── load_seed_data.py   # loads the datasets/ files once you have Supabase keys
├── backend/
│   ├── app.py              # Gradio app — deploy to Hugging Face Spaces
│   ├── requirements.txt
│   └── README.md           # HF Space config header + secrets checklist
└── frontend/
    ├── pages/               # Next.js pages (login, dashboard, chat)
    ├── lib/                 # supabase.js, api.js, useAuth.js
    ├── package.json
    └── .env.local.example
```

## Setup order (do this in sequence)

### 1. Supabase
1. Create a project at supabase.com
2. SQL Editor → paste and run `supabase/schema.sql`
3. Project Settings → API → copy your `Project URL`, `anon` key, and `service_role` key
4. Copy everything from `datasets/` into `supabase/raw_data/` (16 of the 19 files load automatically; see `load_seed_data.py`'s NOTES for the rest), then run `load_seed_data.py` to seed the mines, DGMS stats, production, accidents, air/water quality, compliance items, and mock tables

### 2. Supabase Auth
1. Create a project at supabase.com
2. Authentication → Sign-in method → enable Email/Password
3. Project Settings → General → Web app → copy the config into `frontend/.env.local`

### 3. Groq
1. Get an API key at console.groq.com
2. Add it as a secret in your Hugging Face Space (see below) — never expose it in frontend code

### 4. Backend (Hugging Face Spaces)
1. Create a new Space → SDK: **Gradio**
2. Push the contents of `backend/` to the Space repo
3. Space Settings → Repository secrets → add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`
4. Once live, copy your Space URL (e.g. `https://yourname-coal-backend.hf.space`)

### 5. Frontend (Vercel)
1. `cd frontend && npm install`
2. Copy `.env.local.example` → `.env.local`, fill in Supabase Auth, Supabase (anon key only), and your HF Space URL
3. `npm run dev` to test locally, then push to GitHub and import into Vercel
4. Add the same env vars in Vercel Project Settings → Environment Variables

## What's already wired up
- Supabase Auth email/password login → `/dashboard` redirect → routed to the correct per-role dashboard (`frontend/pages/dashboard/index.js`)
- **Role-based dashboards are fully built and enforced**, one page per role (`frontend/pages/dashboard/{worker,inspector,manager,contractor-manager,corporate,regulator}.js`), each wrapped in `<RoleGuard allowedRoles={[...]}>` (`frontend/components/RoleGuard.js`) — a worker typing `/dashboard/corporate` directly gets redirected back to `/dashboard`, not shown the page
  - Worker: files grievances
  - Inspector: field-inspection form (see below)
  - Manager: compliance checklist, grievances, contractors for their mine
  - Corporate: cross-subsidiary KPIs + high-risk mines list
  - Regulator: national snapshot + audit log
  - Contractor Manager: contractor list with blacklist toggle
- **Inspector field-inspection web form is fully built**: `frontend/pages/dashboard/inspector.js` calls `navigator.geolocation.getCurrentPosition` and submits to the backend's `log_field_inspection` endpoint — no native app involved
- Dashboard pulls live KPIs from the backend (`get_dashboard_summary`, `get_high_risk_mines`)
- Chat page talks to Groq through the backend, grounded with a live Supabase snapshot
- **`ai_risk_flags` is now populated**: `risk_scoring_job.py` computes 4 flag types (Anomalous Accident Rate, Recurring Violation, Compliance Gap, Environmental Threshold Breach) from the seeded data, with Groq-generated (or rule-based fallback) explanations — see its module docstring for exactly how each is computed and its limitations
- **`compliance_tracking` is now seeded**: `seed_compliance_tracking.py` links every mine to its applicable statutory compliance items with a plausible status, so the Manager dashboard (built above) actually has data to show instead of an empty checklist

## What's still a stub / needs your input
- `risk_scoring_job.py`'s "Anomalous Accident Rate" flag only sees mines with mine-level accident linkage (from `coal_dataset_2.xlsx`, now 97 of 152 rows matched after the improved fuzzy matcher below) — most other accident sources are national/subsidiary aggregates with no `mine_id` at all. Extending mine-level accident coverage further would still strengthen this flag.
- Its "Environmental Threshold Breach" flag now uses **graduated confidence** (district-level match where a monitored city's name matches a mine's district exactly, ~21 mines; state-level proxy for the rest, ~129 mines) rather than one flat state-wide flag — but it's still name-matching, not real lat/long-based geocoding.
- `seed_compliance_tracking.py` generates a plausible-but-synthetic compliance history (no real inspection records exist yet).
- **17 of the 19 dataset files** have a seed-loader function written: mines (xlsx), the 4 DGMS CSVs, contractors, grievances, attendance, geo-inspections, both fatal-accident CSVs, both RS (Rajya Sabha) CSVs, air quality, water quality, statutory compliance items, and owner-wise serious accidents — see `load_seed_data.py`
- Several of these required transcription first (PDFs aren't directly loadable): `AIRQUALITY_DATA2023_transcribed.csv` (400 rows), `WQuality_Data-2025_transcribed.csv` (32 rows), `statutory_compliance_items_transcribed.csv` (29 hand-paraphrased rows from the Coal Mines Regulations, 2017 gazette), and `dgms_owner_wise_serious_accidents_2017_2024_transcribed.csv` (178 rows, Table 2.9 of the DGMS Annual Report 2024). All four now sit alongside their source PDFs in `datasets/` and load the same way as the other CSVs
- The only file left with no loader: `coal_dataset_1.pdf` (Coal Directory — turned out to be a statistics yearbook, not a regulations document). The rest of `COAL_DATASET_11_ANNUAL_REPORT.pdf` (cause-wise accident analysis, legislation history, occupational health) is narrative rather than tabular — a good candidate for AI-chat grounding context rather than a new table.

This is a **website-only** platform — every user type (worker, inspector, manager, contractor-manager, corporate, regulator, admin) is served through the responsive Next.js frontend and its role-based dashboards (see `frontend/pages/dashboard/`). There is no separate mobile app; field inspectors log observations through the Inspector dashboard's web form, using the browser's Geolocation API to capture coordinates.

## Setup order for the two new analytics scripts
Run these after `load_seed_data.py`, in this order:
```
python supabase/seed_compliance_tracking.py   # populates compliance_tracking (needed by the Manager dashboard and by the risk job's Compliance Gap flag)
python supabase/risk_scoring_job.py           # populates ai_risk_flags (needed by the Corporate dashboard's high-risk-mines list)
```
Both are safe to leave running on a schedule (cron / GitHub Action / Supabase scheduled function) — `risk_scoring_job.py` clears and recomputes its own table each run, and `seed_compliance_tracking.py` skips itself if the table already has rows.

## Manager write-path + Admin approval flow (new)
- **Manager dashboard** (`manager.js`) now has a working status dropdown per compliance row, wired to a new backend endpoint `update_compliance_status(tracking_id, new_status, remarks)` — managers can actually mark items Completed/Pending/Overdue/Not Applicable instead of the checklist only ever being seedable.
- **Admin dashboard** (`admin.js`, new, routed at `/dashboard/admin`) lists every Supabase Auth-authenticated user with no `user_profiles` row yet (via `list_pending_signups`, which needs `SUPABASE_ANON_KEY` set on the backend) and lets an admin assign them a role/mine/subsidiary (via `approve_user_role`), closing the loop that `pending-approval.js` previously only described as a manual Supabase Table Editor step.
- **Real bug fixed along the way**: `user_profiles.role`'s CHECK constraint in `schema.sql` was missing `'worker'` entirely (even though `dashboard/index.js` and `worker.js` already expected it) — any attempt to approve a worker signup would have failed at the database level. Added `'worker'` and `'admin'` to the constraint.
- **Security note**: both admin endpoints require an `admin_key` matching `ADMIN_SECRET_KEY` (backend env var) / `NEXT_PUBLIC_ADMIN_API_KEY` (frontend env var) — a shared-secret stopgap, not real per-caller auth, since every Gradio-exposed function here is otherwise a public unauthenticated endpoint. See the SECURITY NOTE comment directly above `list_pending_signups` in `backend/app.py` for what a production version should do instead (verify the caller's own Supabase Auth ID token server-side).
- **Bootstrapping the first admin**: there's necessarily a chicken-and-egg problem (you need an admin to approve people, but the first admin has no one to approve them) — insert that one row directly via the Supabase Table Editor, same manual step `pending-approval.js` already describes, just for a single account. Everyone else can go through `/dashboard/admin` after that.

## Improved mine-name matching (new)
`load_seed_data.py`'s fuzzy matcher (used for `coal_dataset_2.xlsx`'s individual accidents, plus the mock contractors/grievances/attendance/geo-inspections CSVs) now does two-stage matching: first-token grouping, then Jaccard token-overlap disambiguation when multiple mines share a first token. Verified against `coal_dataset_2.xlsx`: row-level matches go from 85/152 to 97/152, with every newly-resolved match spot-checked by hand (no false positives introduced) — see the matcher's docstring in `load_seed_data.py` for details.
