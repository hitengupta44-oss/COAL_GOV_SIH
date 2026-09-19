<div align="center">

# ⛏️ Coal Mining Smart Governance Platform

**Statutory compliance, safety findings and field inspections for Indian coal mining — in one record, visible to everyone accountable for it.**

[![Next.js](https://img.shields.io/badge/Next.js-14-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![Gradio](https://img.shields.io/badge/Gradio-HF%20Spaces-FF9D00?logo=huggingface&logoColor=white)](https://huggingface.co/spaces)
[![Groq](https://img.shields.io/badge/Groq-gpt--oss--120b-F55036)](https://groq.com/)
[![PWA](https://img.shields.io/badge/PWA-offline%20ready-5A0FC8)](https://web.dev/progressive-web-apps/)

Smart India Hackathon 2026 · Problem Statement **SIH26024**

[Live demo](#-demo-accounts) · [Architecture](#-architecture) · [Setup](#-setup) · [Roles](#-the-seven-roles)

</div>

---

## The problem

Compliance in Indian coal mining lives in spreadsheets, paper registers and email
threads spread across the pit office, the safety office and corporate HQ. Nobody
knows a mine's real compliance position until an inspector asks for it.

This platform puts it in one record — and shows that record differently to each of
the seven people who need it.

## What it does

| | |
|---|---|
| 📋 **Compliance** | 29 statutory requirements from the Mines Act 1952 and Coal Mines Regulations 2017, tracked across **459 mines** — 11,921 obligations with deadlines |
| 🎯 **Risk scoring** | 192 flags across 4 types: recurring violations, anomalous accident rates (z-score vs national average), compliance gaps, CPCB threshold breaches |
| 🔔 **Alerts** | Overdue items raise alerts addressed to a **role**, not a person. Unacknowledged ones escalate and re-address upward. Self-closing when fixed |
| 📍 **Field app** | Installable PWA. Geo-tagged inspections queue offline and sync on reconnect |
| 📄 **OCR** | Photograph a DGMS observation sheet; Tesseract digitises it on-device. Image never uploaded |
| 🗺️ **GIS** | All 459 mines plotted by risk band |
| 💬 **Assistant** | Grounded in live data, scoped to your role, answers in Hindi, Bengali, Odia, Telugu, Marathi |
| 📑 **Reports** | Statutory compliance as PDF or CSV, generated on demand |

## 📸 Screenshots

> _Add screenshots here: corporate dashboard, GIS map, field app offline._

| Corporate overview | GIS risk map | Field app |
|---|---|---|
| _screenshot_ | _screenshot_ | _screenshot_ |

---

## 🏗️ Architecture

```
  FIELD                DATA                  INTELLIGENCE          GOVERNANCE
  ─────                ────                  ────────────          ──────────
  PWA · GPS · OCR  →   Supabase Postgres  →  Risk scoring      →   7 dashboards
  Offline queue        Row Level Security     Alerts engine         GIS · Reports
                       Audit trail            Groq LLM              Audit trail
       ▲                                                                 │
       └───────────  corrective actions return to the field  ────────────┘
```

<table>
<tr><td><b>Frontend</b></td><td>Next.js 14 · React · PWA (service worker + IndexedDB)</td></tr>
<tr><td><b>Backend</b></td><td>Python · Gradio on Hugging Face Spaces</td></tr>
<tr><td><b>Database</b></td><td>Supabase PostgreSQL with Row Level Security</td></tr>
<tr><td><b>AI</b></td><td>Groq <code>openai/gpt-oss-120b</code> · rule-based risk engine</td></tr>
<tr><td><b>Field</b></td><td>Tesseract.js OCR · browser Geolocation</td></tr>
<tr><td><b>Geo &amp; docs</b></td><td>Leaflet + OpenStreetMap · jsPDF</td></tr>
</table>

---

## 👥 The seven roles

The same record, seen differently — with different powers over it.

| Role | Sees | Can do |
|---|---|---|
| 👷 **Worker** | Own grievances + outcome | File grievances, ask about entitlements |
| 🔍 **Inspector** | Own mine's findings | Geo-tagged inspections, online or offline |
| 🏭 **Mine official** | Everything at their mine | Update compliance, resolve grievances, answer risk flags |
| 📋 **Contractor manager** | Contracts + documents | Manage contracts, blacklist |
| 🏢 **Corporate** | All mines | Everything, everywhere |
| ⚖️ **Regulator** | All mines + audit trail | **Observe only** |
| 🛠️ **Administrator** | Who has access | Approve accounts, assign roles |

<details>
<summary><b>Why the regulator can't edit anything</b></summary>

<br>

Not a compliance status, not a grievance, not a risk flag. Oversight that can
quietly clear its own findings isn't oversight, and an audit trail the observer
can edit is worthless.

Equally, the **mine official is the only role that can both see and act** on
nearly everything at its site — accountability sits there, so the powers do too.
Closing a grievance requires writing what was actually done; a status flag alone
records that somebody clicked something, not that anything happened.

</details>

<details>
<summary><b>How the four loops connect</b></summary>

<br>

**Grievance** — worker files → mine official resolves with a note → regulator sees
it in the audit trail → worker reads the outcome → corporate sees which mines
answer late.

**Compliance** — deadline passes → alert to the mine official → status updated →
audit log records who and when → regulator reviews → report filed.

**Risk** — analytics flags a mine → appears on that official's dashboard → they
mark it addressed *or dispute it*, with a note → corporate and regulator see both
the finding and the answer.

**Inspection** — photograph a paper sheet → OCR drafts it → GPS captured at the
face → queues offline → high severity becomes an alert → tracked to closure.

</details>

---

## 🔐 Access control

**Enforced in the database, not the interface.** Every table carries Row Level
Security policies. A worker querying another mine's grievance gets zero rows —
not a hidden button, an empty result. A direct API call with a valid token returns
only what that person may see.

**Roles cannot be self-assigned.** A new signup gets no profile row and reaches no
dashboard until an admin assigns one. Only admins can write to `user_profiles`.

**Identity is derived, never submitted.** An inspection records the inspector from
their verified session, so nothing can be filed under someone else's name.

> [!NOTE]
> A mine official marking a finding "addressed" is **self-certifying**. The audit
> trail records who claimed it and when, so it's attributable — but nobody
> independently verifies it. Verification is the next iteration, not a solved
> problem.

---

## 📂 Structure

```
backend/
  app.py                           Gradio app; each function is a REST endpoint
  requirements.txt

frontend/
  pages/                           Login, 7 role dashboards, offline page
  components/                      Layout, UI kit, alerts, chat, map, reports, OCR
  lib/                             Supabase client, auth, API client, offline queue
  public/                          PWA manifest, service worker, icons

supabase/
  schema.sql                       Tables, views, RLS policies
  migration_02_workflow.sql        Grievance workflow, contractor compliance
  migration_03_alerts.sql          Alerts and escalation
  migration_04_view_security.sql   Closes an RLS bypass in views
  migration_05_flag_response.sql   Lets mines answer risk flags
  load_seed_data.py                DGMS + CIL source data
  seed_demo_users.py               Demo accounts, one per role
  risk_scoring_job.py              Risk flag generation
  alerts_engine.py                 Alerts, reminders, escalation
```

---

## 🚀 Setup

Order matters — each step depends on the one before.

### 1. Database

Create a Supabase project. In the SQL Editor run `schema.sql`, then migrations
`02` → `05` in order. Under **Authentication → Email**, turn *off* email
confirmation so demo logins work immediately.

### 2. Seed data

```bash
cd supabase
pip install -r requirements.txt

python load_seed_data.py            # mines, accidents, production
python seed_compliance_tracking.py  # statutory obligations
python seed_demo_users.py           # one account per role
python seed_workflow_data.py        # contractor docs, grievance state
python risk_scoring_job.py          # risk flags
python alerts_engine.py             # alerts and escalation
```

Each prompts for your Supabase URL and service-role key. Nothing is written to disk.

### 3. Backend → Hugging Face Spaces

Push `backend/app.py` and `requirements.txt` to a Gradio Space. Add four secrets:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ANON_KEY
GROQ_API_KEY
```

### 4. Frontend → Vercel

Import the repo, set **root directory** to `frontend`, and add:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_BACKEND_URL        # your Space URL, no trailing slash
```

> Full detail and known failure modes: [`DEPLOYMENT.md`](DEPLOYMENT.md)

---

## 🔑 Demo accounts

All use the password `CoalDemo#2026`.

| Email | Role |
|---|---|
| `corporate@coaldemo.in` | Corporate management |
| `regulator@coaldemo.in` | Regulator |
| `manager@coaldemo.in` | Mine official |
| `inspector@coaldemo.in` | Field inspector |
| `contractor@coaldemo.in` | Contractor manager |
| `worker@coaldemo.in` | Worker |

---

## 📚 Data sources

Compliance requirements are **transcribed directly** from the Acts and
Regulations, not paraphrased.

- The Mines Act, 1952 · Coal Mines Regulations, 2017 — DGMS
- Mines Rules, 1955 · Contract Labour (R&A) Act, 1970
- DGMS annual report — inspections, improvement notices, prosecutions
- DGMS fatal & serious accident statistics, owner-wise, 2017–2024
- Indian Coal Mines Dataset (Jan 2021) — 459 mines, location and status
- CPCB National Ambient Air Quality Standards, 2009 · CGWB water quality data
- Rajya Sabha unstarred questions on coal production and safety

Attendance, contractor and grievance records are **synthetic**, generated to
demonstrate the workflows, and flagged as such in the database.

---

<div align="center">
<sub>Built for Smart India Hackathon 2026 · Problem Statement SIH26024</sub>
</div>
