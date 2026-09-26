# Deployment Guide

Deploy in this order. Each step depends on the one before it.

**Stack:** Supabase (database + auth + storage) → Groq (AI chat) → Hugging Face Space (backend, Gradio SDK) → Vercel (frontend, Next.js) → GitHub Actions (scheduled jobs).

> **Already deployed an earlier version?** Skip to [Upgrading an existing deployment](#upgrading-an-existing-deployment).

---

## 1. Supabase — database and auth

1. Create a project at [supabase.com](https://supabase.com). Save the database password somewhere.
2. Open **SQL Editor** and run, one file at a time and **in this order**:
   `schema.sql`, `migration_02_workflow.sql`, `migration_03_alerts.sql`,
   `migration_04_view_security.sql`, `migration_05_flag_response.sql`,
   `migration_06_rls_hardening.sql`, `migration_07_field_operations.sql`,
   `migration_08_returns_and_audit_chain.sql`, `migration_09_predictions.sql`,
   `migration_10_governance_completion.sql`, `migration_11_real_data.sql`,
   `migration_12_real_monitoring.sql`.
   Every migration is safe to re-run. Migration 07 also creates the private
   `evidence` storage bucket and adds the `alerts` table to Realtime.
3. Go to **Settings → API** and copy three values you'll need later:
   - Project URL
   - `anon` public key
   - `service_role` key (secret — backend only, never Vercel)
4. **Authentication → Providers → Email**: make sure Email is enabled.
5. For the demo, turn **off** "Confirm email" (Authentication → Sign In / Providers → Email). Otherwise every new signup has to click a confirmation link before they can log in. The seeded demo users skip this regardless, since `seed_demo_users.py` creates them pre-confirmed.

### Load data

```bash
cd supabase
pip install -r requirements.txt
export SUPABASE_URL="https://your-ref.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

python load_seed_data.py            # mines, production, accidents
python seed_compliance_tracking.py  # compliance checklist rows
python seed_demo_users.py           # demo logins for the judges
python seed_workflow_data.py        # contractor documents, grievance deadlines
python seed_compliance_history.py   # 6 months of past occurrences per obligation
python seed_field_operations.py     # production, environment, attendance,
                                    # incidents, corrective actions, returns,
                                    # demo contractors and crew attendance
python risk_scoring_job.py          # risk flags
python predictive_job.py            # predictions + early warnings
python alerts_engine.py             # alerts and escalation
python load_real_monitoring.py      # CPCB river data 2024, Pakri Barwadih's own
                                    # air readings, Jamuniya's lease extent
python publish_audit_anchor.py      # confirms the audit chain is intact
```

`seed_demo_users.py` prints a table of demo accounts at the end. All share the password `CoalDemo#2026`:

| Email | Role | Shows off |
|---|---|---|
| admin@coaldemo.in | admin | User management, role approval |
| corporate@coaldemo.in | corporate_admin | Subsidiary KPIs, approving returns, verifying fixes |
| regulator@coaldemo.in | regulator | Read-only national oversight, approved returns, audit verification |
| manager@coaldemo.in | mine_official | Compliance with proof, fixes, incidents, production, returns |
| inspector@coaldemo.in | inspector | Geo-tagged inspections with photos, verifying fixes |
| contractor@coaldemo.in | contractor_manager | Contractor register and documents |
| worker@coaldemo.in | worker | Grievances, check-in, incident reporting, Hindi |

> A fix cannot be verified by the person who recorded it. To demo verification
> end to end, record the fix as `manager@` and verify as `inspector@`.

---

## 2. Groq — AI chat

1. Get an API key at [console.groq.com](https://console.groq.com).
2. Hold onto it for steps 3 and 5. Nothing else to configure — the model defaults to `openai/gpt-oss-120b` and can be changed with a `GROQ_MODEL` secret. (`llama-3.3-70b-versatile`, the earlier default, was decommissioned by Groq on 2026-08-16.)

---

## 3. Hugging Face Space — backend

1. Use your **existing** Gradio Space, on **ZeroGPU** hardware.

   Two notes on this:

   - Hugging Face now requires a paid plan to create a *new* Space that runs on compute (Gradio or Docker); only Static Spaces are free to create. An existing Space keeps working, so reuse the one you already have rather than making a new one.
   - ZeroGPU is fine here even though this app never uses a GPU. `requirements.txt` includes the `spaces` package and `app.py` defines a no-op `@spaces.GPU` function, which is what ZeroGPU looks for at startup. Since it's never called, the Space uses none of your daily ZeroGPU quota.

2. Push `backend/app.py` and `backend/requirements.txt` to the Space repo.

3. **Settings → Repository secrets**, add:

   | Secret | Value |
   |---|---|
   | `SUPABASE_URL` | your project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
   | `SUPABASE_ANON_KEY` | anon key |
   | `GROQ_API_KEY` | your Groq key |

4. Wait for the build. The log should end with `Running on local URL: http://0.0.0.0:7860` and stay up.

5. Sanity check — open the Space UI and try the **Dashboard Summary** tab with a junk token. You should get a clean `"Invalid or expired access_token"` rather than a crash. That means auth is wired up correctly.

---

## 4. Vercel — frontend

1. Import the repo at [vercel.com](https://vercel.com), set **Root Directory** to `frontend`.

2. Add environment variables (all three for Production, Preview, and Development):

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | your project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key |
   | `NEXT_PUBLIC_BACKEND_URL` | `https://your-username-your-space.hf.space` (no trailing slash) |

   Only the anon key goes here. `NEXT_PUBLIC_` values are bundled into browser JavaScript and readable by anyone, so the service_role key must never be among them.

3. Deploy, then log in as `admin@coaldemo.in` to confirm the whole chain works.

---

## 5. GitHub Actions — scheduled jobs

Alerts, reminders, escalation and the analytics only happen if something runs
them. `.github/workflows/governance-jobs.yml` does, with nothing to host:

| Schedule | Jobs |
|---|---|
| Hourly | `alerts_engine.py` (marks overdue actions, raises and escalates alerts, emails), `publish_audit_anchor.py` |
| Daily, 06:00 IST | `risk_scoring_job.py`, `predictive_job.py`, then the hourly jobs |

1. Repo **Settings → Secrets and variables → Actions**, add:

   | Secret | Required |
   |---|---|
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | yes |
   | `GROQ_API_KEY` | optional — plain-English risk-flag explanations |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `ALERT_EMAIL_FROM` | optional — email alerts (e.g. a Gmail app password on `smtp.gmail.com:587`) |

2. **Actions → Governance jobs → Run workflow** once to check. Each run's summary
   shows the audit chain's latest hash; a broken chain fails the run and GitHub
   emails the repository owners.

`.github/workflows/db-tests.yml` needs no secrets: it rebuilds the database from
the migrations in a throwaway Postgres and runs the policy tests on every push
that touches `supabase/`.

---

## Upgrading an existing deployment

For a project already running `schema.sql` + migrations 02–05:

1. **Supabase SQL Editor:** run migrations `06`, `07`, `08`, `09`, `10` in order.
   Existing audit entries are chained automatically by migration 08.
2. **Seed the new modules** (optional but recommended for demos):
   `python seed_compliance_history.py`, `python seed_field_operations.py`, then
   `risk_scoring_job.py`, `predictive_job.py`, `alerts_engine.py`.

For a project already on migration 11, run only `migration_12_real_monitoring.sql`, then
`python load_real_monitoring.py` (re-running adds nothing twice). To give a mine its
surveyed lease boundary from a KML (PARIVESH / forest-clearance proposals), run
`python load_lease_boundary.py path/to/file.kml "EXACT MINE NAME"`.

For a project already on migration 10, run only `migration_11_real_data.sql`, then
`python apply_real_data.py` (once; re-running changes nothing), then the three jobs.
It stores each mine's real 2019-20 output, links every mine to its nearest CPCB
air-quality city, and re-links the demo contractors, grievances, attendance and
inspections to the real mines they name.

For a project already on migration 09, run only `migration_10_governance_completion.sql`,
then `seed_compliance_history.py`, `seed_field_operations.py` (it adds only the new
contractor and crew data), and the three jobs.
3. **Backend:** push the new `backend/app.py` to the Space. No new secrets.
4. **Frontend:** redeploy on Vercel. No new variables.
5. **Scheduler:** add the Actions secrets from step 5.
6. Check with the SQL below — every row should say `true`:

   ```sql
   select relname, relrowsecurity from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'
      and relname <> 'spatial_ref_sys'
    order by relrowsecurity, relname;
   ```

> **Why migration 06 matters:** before it, 14 tables — including `grievances`,
> `contractors` and `audit_log` — had RLS switched off, which in Supabase means
> anyone holding the public anon key (it ships in the browser bundle) could read
> and rewrite them. If your live project was set up from the earlier files, it is
> in that state until 06 runs.

---

## Verifying it end to end

1. Log in as `corporate@coaldemo.in` → dashboard KPIs load (frontend → backend → Supabase).
2. Open the chat page, ask "which mines have overdue compliance?" → a real answer (Groq is connected).
3. Log in as `inspector@coaldemo.in`, file an inspection with a photo → allow location and camera access when prompted. The confirmation says whether the position was inside the mine's geo-fence.
4. Log in as `manager@coaldemo.in` → **Corrective actions** → record a fix; then as `inspector@` verify it. As `regulator@` → **Audit trail** → **Verify the audit chain** → "Intact".
5. Log in as `worker@coaldemo.in` and manually visit `/dashboard/corporate` → you get redirected. Role enforcement works.

---

## If something breaks

**Space shows "Runtime error" or restarts repeatedly**
If the log shows a clean startup followed immediately by a clean shutdown with no traceback, the process is being killed from outside rather than crashing. On ZeroGPU that usually means either the `spaces` package is missing from `requirements.txt`, or `app.py` no longer ends with `demo.queue().launch(...)` — ZeroGPU's scheduler hooks into `launch()`, so replacing it with a manual `uvicorn.run()` causes exactly this. Otherwise read the Logs tab from the top; the real traceback is usually above the shutdown lines.

**"Invalid or expired access_token" while logged in**
Supabase access tokens are short-lived. The client refreshes them automatically, so a page refresh normally fixes it. If it persists, confirm `SUPABASE_ANON_KEY` on the Space matches the same project as `NEXT_PUBLIC_SUPABASE_URL` on Vercel.

**"No user_profiles row for this account yet"**
Expected for a brand-new signup — that's the pending-approval flow. Log in as admin and approve them. If it happens to a seeded demo user, re-run `seed_demo_users.py`.

**Frontend calls return 404**
`NEXT_PUBLIC_BACKEND_URL` is wrong or has a trailing slash. Endpoints live at `/api/<function_name>` (Gradio's built-in route), not `/run/<function_name>`, which was removed in Gradio 4.

**Dashboard loads but every table is empty**
The seed scripts probably weren't run, or were run against a different project. Check row counts in the Supabase table editor.

**Postgres error mentioning "infinite recursion detected in policy"**
Something is querying `user_profiles` inside a policy on `user_profiles` itself. The `auth_role()` / `auth_mine_id()` helpers in `schema.sql` are declared `security definer` precisely to avoid this — make sure the whole RLS section ran.

**"permission denied" or empty tables right after migration 06**
Expected for anything a role should not see. If a role that *should* see data gets
nothing, confirm its `user_profiles` row has the right `role` and `mine_id` — every
policy keys off those two fields.

**Photo upload fails with "new row violates row-level security policy"**
Files must go under the uploader's own mine folder (`<mine_id>/...`). This happens
when a user has no `mine_id`; assign one in the admin screen.

**Alerts don't appear live**
Migration 07 adds `alerts` to the `supabase_realtime` publication. Check under
**Database → Publications**. Without it alerts still appear on page load.

**A column is missing from a view after a migration**
Postgres fixes a view's columns when the view is created (`select *` is expanded
then). Migration 07 rebuilds `contractor_compliance_view` for this reason; any new
column on a table behind a `select *` view needs the view recreated.

**`predictive_job.py` says "Not enough outcome history"**
It needs at least 50 obligations with a known outcome (Completed or Overdue). Run
`seed_compliance_tracking.py` first.
