# Deployment Guide

Deploy in this order. Each step depends on the one before it.

**Stack:** Supabase (database + auth) → Groq (AI chat) → Hugging Face Space (backend, Gradio SDK) → Vercel (frontend, Next.js).

---

## 1. Supabase — database and auth

1. Create a project at [supabase.com](https://supabase.com). Save the database password somewhere.
2. Open **SQL Editor** and run the whole of `supabase/schema.sql`. This creates every table plus the Row Level Security policies.
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

python load_seed_data.py          # mines, production, accidents
python seed_compliance_tracking.py # compliance checklist rows
python seed_demo_users.py          # demo logins for the judges
```

`seed_demo_users.py` prints a table of demo accounts at the end. All share the password `CoalDemo#2026`:

| Email | Role | Shows off |
|---|---|---|
| admin@coaldemo.in | admin | User management, role approval |
| corporate@coaldemo.in | corporate_admin | Cross-subsidiary KPIs |
| regulator@coaldemo.in | regulator | Read-only national oversight |
| manager@coaldemo.in | mine_official | Updating compliance items |
| inspector@coaldemo.in | inspector | Geo-tagged field inspections |
| contractor@coaldemo.in | contractor_manager | Contractor workforce view |
| worker@coaldemo.in | worker | Limited single-mine view |

---

## 2. Groq — AI chat

1. Get an API key at [console.groq.com](https://console.groq.com).
2. Hold onto it for step 3. Nothing else to configure — the model (`llama-3.3-70b-versatile`) is set by an env var with a sensible default.

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

## Verifying it end to end

1. Log in as `corporate@coaldemo.in` → dashboard KPIs load (frontend → backend → Supabase).
2. Open the chat page, ask "which mines have overdue compliance?" → a real answer (Groq is connected).
3. Log in as `inspector@coaldemo.in`, file an inspection → allow location access when the browser prompts.
4. Log in as `worker@coaldemo.in` and manually visit `/dashboard/corporate` → you get redirected. Role enforcement works.

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
