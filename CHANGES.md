# Changes since the GitHub version

## Round 4 — real monitoring data and lease boundaries (migration 12)

| Area | Was | Now |
|---|---|---|
| River water quality | Yamuna stations only, nowhere near a coalfield | CPCB NWMP **2024**: all 1,555 stations parsed from the PDF; 66 on coal-belt rivers (Damodar, Barakar, Hasdeo, Kelo, Ib, Brahmani, Sone, Rihand, Wardha, Godavari, Kinnerasani…) placed on the map. Each mine shows its three nearest stations within 25 km (260 mines), checked against CPCB's criteria; oversight roles get a coal-belt table, worst first |
| A mine's own monitoring | Synthetic readings only | **Pakri Barwadih (NTPC)**: 720 real readings, 183 days of its continuous air station from its EC compliance report, stored with the report as source. History does not raise live alerts |
| Monitoring faults | Not detected | The page flags an analyser that repeats the same value for 5+ readings or reads zero. It found one straight away: Pakri Barwadih's PM10 is exactly 60.87 for 35 days and 0 for 13 |
| Geo-fence | Circle around a point | Follows the **lease boundary** where one is loaded (inside, or within 250 m for GPS error); the map draws it. Jamuniya UG's lease extent from its EC report is loaded; `load_lease_boundary.py` adds a KML polygon for any mine and refuses one more than 25 km away |

New files: `supabase/migration_12_real_monitoring.sql`, `supabase/load_real_monitoring.py`,
`supabase/load_lease_boundary.py`, `supabase/raw_data/WQuality_River-Data-2024_parsed.csv`,
`supabase/raw_data/nwmp_station_coordinates.csv`, `supabase/raw_data/pakri_barwadih_caaqms_2023-24.csv`,
`frontend/components/RiverWater.js`. Changed: `frontend/pages/dashboard/operations.js`,
`frontend/components/MineMap.js`, `tests/test_policies.py` (140 checks).

## Round 3 — real data where it exists (migration 11)

| Area | Was | Now |
|---|---|---|
| Production targets | Random 1,500–9,000 t a day | Each mine's **actual 2019-20 output ÷ 365** (Indian Coal Mines Dataset); the chart says which basis it uses. Mines with no meaningful output on record keep an illustrative target, labelled as such |
| Ambient air quality | CPCB 2023 data loaded but linked to nothing | Every mine linked to its **nearest CPCB city within 60 km** (346 of 459 mines); Production & environment shows PM10, PM2.5, SO₂, NO₂ against the NAAQS annual limits, and oversight roles get a coal-belt table, worst city first |
| Demo records | Contractors, grievances, attendance and inspections carried random subsidiaries; inspections sat hundreds of km from their mine; ~¼ resolved to no mine, so the alerts engine skipped them | All 415 rows attached to the real mine they name, under its real subsidiary; inspection GPS within 2 km of the mine (4 deliberately off-site for the geo-fence check). Nothing is skipped any more |
| Charts | Switching mine left the production and environment charts blank | Fixed |

New files: `supabase/migration_11_real_data.sql`, `supabase/apply_real_data.py`,
`supabase/remap_mock_csvs.py` (the one-off that corrected the CSVs, kept for the record),
`supabase/raw_data/cpcb_city_coordinates.csv`, `frontend/components/AmbientAir.js`.
Changed: the four `raw_data/*_mock.csv` files, `load_seed_data.py`, `seed_field_operations.py`,
`frontend/pages/dashboard/operations.js`, `tests/test_policies.py` (132 checks).

## Round 2 — closing the partly-done items (migration 10)

| PS asks for | Was | Now |
|---|---|---|
| Recurring compliance failures | Undetectable: each obligation had one occurrence and nothing created the next | Obligations **recur on their statutory cycle**; completing one schedules the next, missed dates turn Overdue automatically; each obligation shows its 12-month track record; new **Recurring Compliance Failure** risk flag (peer-relative) |
| GIS mapping | Mines coloured by risk only | Switchable layers: risk heatmap, open findings (late / off-site marked), incidents, off-site check-ins linked to their mine, the mine's own geo-fence |
| Statutory report generation | Returns prepared by hand | Prepared **automatically** each month (quarterly for environment) for every mine; due by the 7th; reminders and escalation when late |
| Digital approvals | Returns only | Second workflow: **contractor onboarding approval**, gated on four in-date statutory documents, by someone other than the person who added the contractor |
| Worker attendance (contract labour) | Only people with accounts | **Crew attendance** recorded per contractor per shift, geo-tagged; unapproved/blacklisted contractors blocked; lapsed documents alert the mine instantly |
| Scalable deployment | Rate limiter in one process's memory | Rate limiting in the database (works across restarts and instances); extra indexes; scaling notes in the README |

Also: the predictive model's "likely to be missed" threshold is now relative to the national
miss rate (it silently stopped warning when history changed the base rate); the AI assistant
now sees repeated failures, contractors awaiting approval, crews under lapsed documents and
overdue returns. Database tests: 126 checks (was 93).

New files: `supabase/migration_10_governance_completion.sql`, `supabase/seed_compliance_history.py`,
`frontend/components/ContractorApprovals.js`, `frontend/components/CrewAttendance.js`.

Deploy: run migration 10, then `seed_compliance_history.py`, `seed_field_operations.py`,
`risk_scoring_job.py`, `predictive_job.py`, `alerts_engine.py`; push backend `app.py`;
redeploy the frontend.

## Round 1

Measured against the problem statement. Grouped by what it closes.

## Security fixes (deploy these first)

- **Row Level Security on every table** (`migration_06`). Fourteen tables had RLS
  off -- including `grievances`, `contractors` and `audit_log` -- which in Supabase
  means anyone with the public anon key could read *and rewrite* them. The
  contractor policies in migrations 04/05 had no effect for the same reason.
- **Audit log is append-only.** No user can write to it through the API, and a
  trigger blocks UPDATE, DELETE and TRUNCATE even for the database owner.
- **Grievance privacy.** Workers see only what they filed; a filer can no longer
  mark their own grievance Resolved; complaint text is redacted from the audit
  trail and never enters another user's AI-assistant context (the assistant
  previously let any worker ask for colleagues' grievances).
- **Alerts with no mine** no longer reach every mine official in the country.
- **Offline queue on shared phones** sends each record under the identity of the
  person who made it; cached data is cleared on logout.
- Views no longer granted to `anon`; contractor documents scoped to the manager's
  own mine.

## Problem statement coverage added

| PS asks for | Added |
|---|---|
| Inspections → violations → **corrective actions** | Full loop: Open → In Progress → Action Taken → **independently verified** Closed / Reopened; deadlines by severity; photo evidence mandatory for Critical; nobody verifies their own fix; overdue marking by scheduler |
| **Incident reporting** | Incident module for all mine roles, offline-capable, with photos; severity and DGMS notifiability derived; instant alerts to mine, corporate and regulator; cannot close without DGMS notice reference and root cause |
| **Attendance** | Personal geo-fenced check-in/out, identity from session, offline with 72-hour window, roster and exceptions for the official, daily headcount |
| **Production reporting** | Shift-wise production entry, trend chart against target, z-score anomaly detection |
| **Environmental monitoring** | Readings checked against CPCB NAAQS / EP Rules Sch. VI / Noise Rules limits on entry; breach alerts; readings append-only |
| **Digital approvals** + **statutory report generation** | Statutory returns: figures generated by the database, SHA-256 fingerprinted at submission, corporate approves or sends back, regulator sees approved filings only, PDF with fingerprint and approval record |
| **Predictive alerts** | `predictive_job.py`: explainable logistic regression per pending obligation, 14-day early-warning alerts, mine-level "Predicted Non-Compliance" flags, cross-validated AUC published |
| **Operational anomalies** | New "Operational Anomaly" flag: production outliers and records made outside the geo-fence |
| **Geo-tagged** reporting | Every inspection, incident and check-in is checked against its mine's location in the database |
| **Secure / blockchain-style audit trail** | Hash-chained audit log, database-level audit triggers on every workflow table, one-click verification, chain head published outside the database each run |
| **Automated reminders and escalation** | GitHub Actions scheduler (hourly alerts, daily analytics); email digests; real-time alerts on open dashboards with device notifications |
| **OCR / paperless** | Photo evidence on inspections, fixes, incidents, compliance completion and contractor documents (private bucket); Hindi OCR |
| **Multilingual** | Hindi/English interface for field screens |
| **Scalable across subsidiaries** | Subsidiary filter applied to every corporate KPI, flag list and prediction |
| **Contractor management** | Add contractors and record documents with scans |

## Bugs fixed

- Risk engine scored only the first 1,000 of ~12,000 compliance rows (PostgREST
  page cap); compliance-gap flags are now relative to peer mines (386 → 88 flagged).
- Risk engine and backend used the decommissioned `llama-3.3-70b-versatile` in
  places; risk engine now uses `gpt-oss-120b` with a budget that fits a reasoning model.
- Alert escalation jumped from level 1 to 2 on the very next run.
- Assistant context: risk flags and contractor documents were fetched nationally
  then filtered, so most mines saw none; overdue-by-mine count was capped at 1,000 rows.
- Dashboard summary ignored the subsidiary filter for everything except the mine count.
- Offline inspections were stamped with sync time instead of capture time.
- `contractor_compliance_view` could not show new columns (`select *` is fixed at
  view creation) -- rebuilt.
- Shared `Button` lost its colours whenever a `style` prop was passed.

## Testing added

- `supabase/tests/`: 93 policy and workflow checks run as each role against a
  fresh database built from the migrations, including the attempts that must fail.
  Runs in CI on every change to `supabase/` (`.github/workflows/db-tests.yml`).
- Verified before handover (not committed -- needs a local stack): every role's
  pages load without errors in a real browser (31/31), and 21 end-to-end workflow
  checks driven through the UI pass.

## Deploy order

Migrations `06` → `09` in the Supabase SQL editor → `seed_field_operations.py` →
`risk_scoring_job.py`, `predictive_job.py`, `alerts_engine.py` → push backend →
redeploy frontend → add GitHub Actions secrets. Details in `DEPLOYMENT.md`.
