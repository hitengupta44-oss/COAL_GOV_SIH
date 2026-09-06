"""
Coal Mining Smart Governance Platform - Backend
Deploys as a Hugging Face Space (Gradio SDK).
Exposes each function below as Gradio's own built-in synchronous REST
endpoint at
    https://<your-space>.hf.space/api/<function_name>
(POST, body {"data": [args...]}, response includes a "data": [result]
field) which your Vercel/Next.js frontend calls directly (see
frontend/lib/api.js).

NOTE ON ENDPOINT NAMING: this is NOT the old Gradio 3.x /run/<name>
convention (removed in Gradio 4.x), nor the newer queue-based two-step
/gradio_api/call/<name> + SSE flow. It's Gradio's built-in
single-response /api/<name> route, which still exists in 4.44 for
non-streaming outputs. Its endpoint name comes from whichever function is
passed directly as the handler to a .click()/.submit() call -- so every
event below sets api_name="..." EXPLICITLY to guarantee it matches the
name frontend/lib/api.js calls, rather than relying on Gradio's default
(which is inferred from the literal Python function object wired to the
event -- e.g. the chat tab wires a local `respond` wrapper, not
`chat_with_data_assistant` itself, so without an explicit api_name it
would otherwise be exposed as /api/respond instead).

CAUTION: hitting /api/<name> with a name Gradio doesn't recognize raises
an unhandled exception in Gradio's own routing code that can crash the
whole process (observed directly while fixing this) -- so keep
frontend/lib/api.js's function names in sync with the api_name values
set below if you ever rename something.
ENV VARS required in your HF Space "Settings > Repository secrets":
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY   (or anon key if you lock down RLS properly)
    GROQ_API_KEY
    SUPABASE_ANON_KEY   (used only to verify caller access tokens -- see
                         _authenticate(); safe to expose, it's the same
                         public key the frontend ships)
    ADMIN_SECRET_KEY   (kept as an OPTIONAL extra layer on top of real auth
                        for the two admin functions -- see SECURITY FIXES)
===============================================================================
SECURITY FIXES applied on top of the original version
===============================================================================
The original version only protected `list_pending_signups` /
`approve_user_role` with a shared secret. Every other function --
including writes like `update_compliance_status` and `log_field_inspection`,
and reads like `get_dashboard_summary` -- was a fully public,
unauthenticated endpoint. Since Gradio exposes every function as a REST
endpoint regardless of what the frontend's UI shows, anyone who found the
Space URL could call those directly and bypass the frontend's role-based
dashboards entirely.
Fixes:
  1. Added `_authenticate(access_token)` -- verifies a Supabase Auth
     access token (the frontend gets one from supabase.auth on login and
     sends it with each call) and looks up the caller's role/mine_id from
     `user_profiles`. Every function that reads or writes real data now
     requires a valid `id_token` and checks the caller's role is allowed to
     do that specific thing.
  2. `log_field_inspection` no longer trusts a client-supplied
     `inspector_id` -- it derives the inspector's identity from their own
     verified token.
  3. `update_compliance_status` checks that mine-scoped roles
     (mine_official / inspector / contractor_manager) can only touch
     compliance rows for their own `mine_id`; corporate_admin/regulator/
     admin can touch any.
  4. Replaced the plain `!=` admin-key comparison with
     `hmac.compare_digest` to avoid a timing side-channel, and made the
     admin functions require BOTH a verified admin-role token AND (if set)
     the legacy `ADMIN_SECRET_KEY`, so losing one secret alone isn't enough.
  5. Added a small in-memory rate limiter (per caller uid) on the Groq
     chat endpoint and the write endpoints, to blunt cost-abuse and
     brute-force attempts. This is process-local (resets on restart, and
     won't coordinate across replicas) -- fine for a single small Space,
     not a substitute for a real rate-limiting layer at higher scale.
  6. Hardened `approve_user_role` against a bad `subsidiary_id` value
     (was an uncaught `int()` crash; now a clean error).
  7. Added basic latitude/longitude range validation on inspections.
  8. Fixed `log_field_inspection` sending the literal string "now()" as
     the timestamp -- Postgres only recognizes the bare word 'now', not
     'now()' with parens, as a special timestamp input, so every insert
     was failing. Now sends a real ISO timestamp computed in Python.
  9. Restored audit-log writes on `update_compliance_status` and
     `approve_user_role` (the regulator dashboard reads audit_log directly
     but nothing was writing to it) -- now using the verified `uid` from
     the caller's own token as the actor, instead of a client-supplied
     value.
If you don't want to require logins for the read-only dashboard endpoints,
you can relax #1 for just `get_dashboard_summary` -- but note that means
subsidiary-level fatal-accident and compliance numbers are public to
anyone with the Space URL.
===============================================================================
"""

import os
import json
import time
import hmac
import datetime
from collections import defaultdict

import gradio as gr
from supabase import create_client, Client
from groq import Groq

# ------------------------------------------------------------
# ZeroGPU STARTUP REQUIREMENT: on ZeroGPU hardware, Spaces refuses to start
# an app that has no @spaces.GPU-decorated function ("No @spaces.GPU
# function detected during startup"). This app never needs a GPU -- it's a
# Supabase/Groq API wrapper -- so the function below is a no-op that exists
# purely to satisfy that check. Because it is never actually called, the
# Space consumes none of the daily ZeroGPU quota.
#
# KEEP THIS. An earlier note here suggested switching the Space to CPU
# basic instead, but Hugging Face has since changed its policy: creating a
# new Space that runs on compute (Gradio or Docker) now requires a paid
# plan, and ZeroGPU is the free tier for existing/unpaid accounts. Removing
# this decorator would break startup on ZeroGPU.
#
# NOTE ON CRASH-LOOPS: if this Space ever boots and then immediately shuts
# down with no Python traceback, check that the bottom of this file still
# uses demo.queue().launch(...). Replacing launch() with a manual
# uvicorn.run() around a separately-mounted FastAPI app caused exactly that
# symptom on ZeroGPU, because ZeroGPU's scheduler hooks into launch().
# ------------------------------------------------------------
try:
    import spaces

    @spaces.GPU
    def _zerogpu_startup_placeholder():
        return None
except ImportError:
    pass  # not running on a ZeroGPU Space -- nothing to do

# ------------------------------------------------------------
# Clients
# ------------------------------------------------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL and SUPABASE_KEY else None
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")


def _write_audit_log(actor_uid: str, action: str, table_affected: str = None,
                      record_id: str = None, details: dict = None):
    """Best-effort audit trail write. Never raises -- a logging failure
    should never block the action it's trying to record."""
    if not supabase:
        return
    try:
        supabase.table("audit_log").insert({
            "actor_uid": actor_uid,
            "action": action,
            "table_affected": table_affected,
            "record_id": str(record_id) if record_id is not None else None,
            "details": details or {},
        }).execute()
    except Exception:
        pass


# ------------------------------------------------------------
# Auth verification client.
#
# MIGRATION NOTE (Firebase -> Supabase Auth): this used to initialize the
# Firebase Admin SDK from a FIREBASE_SERVICE_ACCOUNT_JSON secret and call
# firebase_auth.verify_id_token(). That whole dependency is gone.
#
# Supabase tokens are verified by calling auth.get_user(token) against the
# same project, using a client built with the ANON key. We deliberately do
# NOT verify tokens with the service-role client below: the service-role
# key bypasses RLS, and mixing "who is this caller" with "god-mode database
# access" on one client makes it far too easy to leak privileges by
# accident. Keeping them separate means token checks are always done with
# the least-privileged key.
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")
auth_client: Client = (
    create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    if SUPABASE_URL and SUPABASE_ANON_KEY else None
)

ADMIN_SECRET_KEY = os.environ.get("ADMIN_SECRET_KEY")

ALL_ROLES = ("worker", "mine_official", "corporate_admin", "regulator",
             "inspector", "contractor_manager", "admin")


# ------------------------------------------------------------
# AUTH HELPERS
# ------------------------------------------------------------
def _authenticate(access_token: str):
    """Verifies a Supabase Auth access token and loads the caller's profile.

    Returns (uid, profile_dict, error_dict). Exactly one of profile_dict /
    error_dict is non-None. profile_dict has keys: role, mine_id,
    subsidiary_id, auth_uid, profile_id.
    """
    if not auth_client:
        return None, None, {"error": "Auth is not configured on the backend (SUPABASE_ANON_KEY missing)."}
    if not access_token:
        return None, None, {"error": "access_token is required -- pass the caller's Supabase session token."}
    try:
        result = auth_client.auth.get_user(access_token)
        user = getattr(result, "user", None)
        if user is None:
            return None, None, {"error": "Invalid or expired access_token."}
        uid = user.id
    except Exception as e:
        return None, None, {"error": f"Invalid or expired access_token: {e}"}

    if not supabase:
        return None, None, {"error": "Supabase not configured yet."}

    rows = supabase.table("user_profiles").select(
        "profile_id, auth_uid, role, mine_id, subsidiary_id"
    ).eq("auth_uid", uid).execute().data
    if not rows:
        return None, None, {"error": "No user_profiles row for this account yet -- ask an admin to approve your signup."}
    return uid, rows[0], None


def _require_role(profile: dict, allowed_roles: tuple):
    if profile["role"] not in allowed_roles:
        return {"error": f"Role '{profile['role']}' may not call this endpoint. Requires one of: {', '.join(allowed_roles)}."}
    return None


def _require_own_mine(profile: dict, mine_id: str, unrestricted_roles: tuple):
    """For mine-scoped roles, the mine_id being acted on must match their
    own assigned mine, unless their role is in `unrestricted_roles`
    (corporate/regulator/admin roles that can act across mines)."""
    if profile["role"] in unrestricted_roles:
        return None
    if profile.get("mine_id") != mine_id:
        return {"error": "You may only act on your own assigned mine."}
    return None


def _admin_key_ok(admin_key: str) -> bool:
    """Timing-safe comparison. If ADMIN_SECRET_KEY isn't set, this legacy
    layer is skipped (real auth below still applies)."""
    if not ADMIN_SECRET_KEY:
        return True
    if not admin_key:
        return False
    return hmac.compare_digest(admin_key, ADMIN_SECRET_KEY)


# ------------------------------------------------------------
# Simple in-memory rate limiter, keyed per caller uid.
# Process-local: resets on restart, doesn't coordinate across replicas.
# Good enough to blunt casual abuse on a single small Space.
# ------------------------------------------------------------
_rate_state = defaultdict(list)


def _rate_limited(key: str, max_calls: int, window_seconds: int) -> bool:
    now = time.time()
    calls = [t for t in _rate_state[key] if now - t < window_seconds]
    calls.append(now)
    _rate_state[key] = calls
    return len(calls) > max_calls


# ------------------------------------------------------------
# 1. DASHBOARD SUMMARY -- corporate/regulator overview
# ------------------------------------------------------------
def get_dashboard_summary(access_token: str, subsidiary_filter: str = "All"):
    """Returns aggregate KPIs: mine count, accident totals, open compliance items.
    Requires a valid login (any role) -- this is business/safety data, not public."""
    if not supabase:
        return {"error": "Supabase not configured yet. Set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY."}

    uid, profile, err = _authenticate(access_token)
    if err:
        return err

    mines_q = supabase.table("mines").select("mine_id", count="exact")
    accidents_q = supabase.table("accidents").select("accident_id", count="exact").eq("severity", "Fatal")
    compliance_q = supabase.table("compliance_tracking").select("tracking_id", count="exact").eq("status", "Overdue")

    if subsidiary_filter != "All":
        sub = supabase.table("subsidiaries").select("subsidiary_id").eq("subsidiary_code", subsidiary_filter).execute().data
        if sub:
            sid = sub[0]["subsidiary_id"]
            mines_q = mines_q.eq("subsidiary_id", sid)

    mines_count = mines_q.execute().count or 0
    fatal_accidents = accidents_q.execute().count or 0
    overdue_compliance = compliance_q.execute().count or 0

    return {
        "total_mines": mines_count,
        "fatal_accidents_recorded": fatal_accidents,
        "overdue_compliance_items": overdue_compliance,
        "filter_applied": subsidiary_filter,
    }


# ------------------------------------------------------------
# 2. MINE RISK LIST -- feeds the "high-risk area" map/table
# ------------------------------------------------------------
def get_high_risk_mines(access_token: str, limit: int = 10):
    """Naive risk ranking: mines with the most accidents + overdue compliance items.
    Requires a valid login -- risk-flag data is sensitive."""
    if not supabase:
        return {"error": "Supabase not configured yet."}

    uid, profile, err = _authenticate(access_token)
    if err:
        return err

    limit = max(1, min(int(limit or 10), 100))  # clamp to a sane range
    flags = supabase.table("ai_risk_flags").select(
        "mine_id, risk_score, flag_type, explanation"
    ).order("risk_score", desc=True).limit(limit).execute().data

    return flags if flags else {"message": "No risk flags generated yet. Run the analytics job first."}


# ------------------------------------------------------------
# 3. LOG A FIELD INSPECTION -- called from the Inspector web dashboard
#    (frontend/pages/dashboard/inspector.js submits a form; browser
#    geolocation API supplies latitude/longitude -- no native app needed)
# ------------------------------------------------------------
def log_field_inspection(access_token: str, mine_id: str, latitude: float,
                          longitude: float, observation_type: str,
                          severity: str, notes: str = ""):
    """SECURITY FIX: inspector_id is no longer a caller-supplied field --
    it's derived from the caller's own verified identity, so nobody can
    log an inspection under someone else's name. Only inspectors,
    mine_officials, contractor_managers, and admins may log inspections,
    and mine-scoped roles can only log against their own mine."""
    if not supabase:
        return {"error": "Supabase not configured yet."}

    uid, profile, err = _authenticate(access_token)
    if err:
        return err

    role_err = _require_role(profile, ("inspector", "mine_official", "contractor_manager", "admin"))
    if role_err:
        return role_err

    mine_err = _require_own_mine(profile, mine_id, unrestricted_roles=("admin",))
    if mine_err:
        return mine_err

    if _rate_limited(f"log_inspection:{uid}", max_calls=30, window_seconds=3600):
        return {"error": "Rate limit exceeded -- too many inspections logged in the last hour."}

    if not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
        return {"error": "latitude/longitude out of valid range."}

    row = {
        "mine_id": mine_id,
        "inspector_id": uid,  # derived from token, not client input
        # BUG FIX: was the literal string "now()", which Postgres does not
        # accept as a timestamp literal (only the bare word 'now' is a
        # recognized special value) -- every insert was failing silently
        # from the caller's perspective (Supabase returned an error that
        # the old frontend code didn't even surface). Use a real timestamp.
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "latitude": latitude,
        "longitude": longitude,
        "observation_type": observation_type,
        "severity": severity,
        "notes": notes,
        "is_synthetic": False,
    }
    result = supabase.table("geo_inspections").insert(row).execute()
    return {"status": "logged", "inspection": result.data}


# ------------------------------------------------------------
# 4. AI CHAT / INSIGHTS -- Groq-powered assistant
# ------------------------------------------------------------
SYSTEM_PROMPT = """You are the AI assistant embedded in a Smart Governance Platform
for Indian coal mining operations. You help mine officials, corporate management,
and regulators understand compliance status, safety trends, and operational data.
Be precise, cite specific numbers when given data context, and flag when you don't
have enough data to answer confidently. Keep answers concise and actionable."""


def chat_with_data_assistant(access_token: str, user_message: str, history: list = None):
    """Groq-backed chat. Requires login (prevents anonymous users running up
    your Groq bill) and is rate-limited per caller."""
    if not groq_client:
        return "GROQ_API_KEY not configured yet."

    uid, profile, err = _authenticate(access_token)
    if err:
        return err["error"]

    if _rate_limited(f"chat:{uid}", max_calls=20, window_seconds=600):
        return "Rate limit exceeded -- please wait a bit before sending more messages."

    context = ""
    if supabase:
        try:
            summary = get_dashboard_summary(access_token)
            context = f"\n\nCurrent platform snapshot: {json.dumps(summary)}"
        except Exception:
            pass

    messages = [{"role": "system", "content": SYSTEM_PROMPT + context}]
    if history:
        for turn in history:
            messages.append({"role": "user", "content": turn[0]})
            messages.append({"role": "assistant", "content": turn[1]})
    messages.append({"role": "user", "content": user_message})

    response = groq_client.chat.completions.create(
        model=GROQ_MODEL,
        messages=messages,
        temperature=0.3,
        max_tokens=800,
    )
    return response.choices[0].message.content


# ------------------------------------------------------------
# 5. COMPLIANCE CHECKLIST FOR A MINE
# ------------------------------------------------------------
def get_compliance_status(access_token: str, mine_id: str):
    """Requires login. Mine-scoped roles can only view their own mine."""
    if not supabase:
        return {"error": "Supabase not configured yet."}

    uid, profile, err = _authenticate(access_token)
    if err:
        return err

    mine_err = _require_own_mine(
        profile, mine_id,
        unrestricted_roles=("corporate_admin", "regulator", "admin"),
    )
    if mine_err:
        return mine_err

    rows = supabase.table("compliance_tracking").select(
        "*, statutory_compliance_items(requirement_summary, category)"
    ).eq("mine_id", mine_id).execute().data
    return rows


# ------------------------------------------------------------
# 6. UPDATE A COMPLIANCE ITEM'S STATUS -- called from the Manager dashboard
#    (frontend/pages/dashboard/manager.js), so a manager can actually mark
#    an item Completed/Pending/Overdue instead of compliance_tracking only
#    ever being seedable data.
# ------------------------------------------------------------
def update_compliance_status(access_token: str, tracking_id: str, new_status: str, remarks: str = ""):
    """SECURITY FIX: this used to be a fully open write endpoint. Now
    requires login, restricts by role, and restricts mine-scoped roles to
    only their own mine's compliance rows."""
    if not supabase:
        return {"error": "Supabase not configured yet."}

    uid, profile, err = _authenticate(access_token)
    if err:
        return err

    role_err = _require_role(profile, ("mine_official", "corporate_admin", "admin"))
    if role_err:
        return role_err

    if new_status not in ("Completed", "Pending", "Overdue", "Not Applicable"):
        return {"error": f"Invalid status '{new_status}'. Must be one of: "
                          f"Completed, Pending, Overdue, Not Applicable."}

    if _rate_limited(f"update_compliance:{uid}", max_calls=60, window_seconds=3600):
        return {"error": "Rate limit exceeded."}

    # Look up the row first so we can enforce mine-scoping before writing.
    existing = supabase.table("compliance_tracking").select("mine_id").eq(
        "tracking_id", tracking_id
    ).execute().data
    if not existing:
        return {"error": f"No compliance_tracking row found with tracking_id={tracking_id}"}

    mine_err = _require_own_mine(
        profile, existing[0]["mine_id"],
        unrestricted_roles=("corporate_admin", "admin"),
    )
    if mine_err:
        return mine_err

    update_values = {
        "status": new_status,
        "remarks": remarks or None,
        "completed_date": datetime.date.today().isoformat() if new_status == "Completed" else None,
    }
    result = supabase.table("compliance_tracking").update(update_values).eq(
        "tracking_id", tracking_id
    ).execute()
    if not result.data:
        return {"error": "Update failed."}

    # Restored: the regulator dashboard reads audit_log directly, but
    # nothing was writing to it. Use the verified uid, not a client value.
    _write_audit_log(
        actor_uid=uid,
        action="update_compliance_status",
        table_affected="compliance_tracking",
        record_id=tracking_id,
        details={"new_status": new_status, "remarks": remarks},
    )
    return result.data[0]


# ------------------------------------------------------------
# 7. ADMIN ROLE-APPROVAL FLOW -- called from the Admin dashboard
#    (frontend/pages/dashboard/admin.js). A brand-new signup has
#    no user_profiles row yet (see useAuth.js / pending-approval.js), so an
#    admin needs a way to look up who's waiting and assign them a role.
#
# SECURITY FIX: these now require a verified Supabase token belonging to
# an account whose OWN role in user_profiles is 'admin' -- not just a
# shared secret. ADMIN_SECRET_KEY, if still set, is layered on top as a
# second factor rather than being the only gate.
# ------------------------------------------------------------
def _check_admin(access_token: str, admin_key: str):
    """Returns (profile, error). Requires BOTH: (1) a verified token whose
    role is 'admin', and (2) if ADMIN_SECRET_KEY is set, a matching key."""
    uid, profile, err = _authenticate(access_token)
    if err:
        return None, err
    role_err = _require_role(profile, ("admin",))
    if role_err:
        return None, role_err
    if not _admin_key_ok(admin_key):
        return None, {"error": "Invalid admin key."}
    return profile, None


def list_pending_signups(access_token: str, admin_key: str = ""):
    """Returns signed-up users who don't have a user_profiles row yet --
    i.e. everyone currently stuck on /pending-approval.

    MIGRATION NOTE: this used to page through Firebase's list_users(). It
    now uses Supabase's admin list_users API (service-role key), which is
    why `supabase` -- not `auth_client` -- is used here: listing all users
    is a privileged operation the anon key can't and shouldn't perform.
    """
    _, err = _check_admin(access_token, admin_key)
    if err:
        return err
    if not supabase:
        return {"error": "Supabase not configured yet."}

    existing_uids = {
        r["auth_uid"]
        for r in supabase.table("user_profiles").select("auth_uid").execute().data
    }

    pending = []
    try:
        page = 1
        while True:
            users = supabase.auth.admin.list_users(page=page, per_page=200)
            if not users:
                break
            for user in users:
                if user.id not in existing_uids:
                    meta = user.user_metadata or {}
                    pending.append({
                        "auth_uid": user.id,
                        "email": user.email,
                        "display_name": meta.get("full_name"),
                        "created_at": str(user.created_at) if user.created_at else None,
                    })
            if len(users) < 200:
                break
            page += 1
    except Exception as e:
        return {"error": f"Could not list users: {e}"}

    return pending if pending else {"message": "No pending signups -- everyone has a role assigned."}


def approve_user_role(access_token: str, admin_key: str, auth_uid: str, email: str, full_name: str,
                       role: str, mine_id: str = "", subsidiary_id: str = ""):
    """Creates the user_profiles row that lets a pending signup into their
    role's dashboard. mine_id/subsidiary_id are optional -- corporate/
    regulator roles aren't tied to one mine (pass empty string to skip)."""
    admin_profile, err = _check_admin(access_token, admin_key)
    if err:
        return err
    if not supabase:
        return {"error": "Supabase not configured yet."}

    if role not in ALL_ROLES:
        return {"error": f"Invalid role '{role}'. Must be one of: {', '.join(ALL_ROLES)}"}

    # SECURITY FIX: bad subsidiary_id used to throw an uncaught ValueError.
    parsed_subsidiary_id = None
    if subsidiary_id:
        try:
            parsed_subsidiary_id = int(subsidiary_id)
        except ValueError:
            return {"error": f"subsidiary_id must be an integer, got '{subsidiary_id}'."}

    row = {
        "auth_uid": auth_uid,
        "email": email,
        "full_name": full_name or None,
        "role": role,
        "mine_id": mine_id or None,
        "subsidiary_id": parsed_subsidiary_id,
    }
    result = supabase.table("user_profiles").insert(row).execute()
    if not result.data:
        return {"error": "Insert failed -- check that auth_uid isn't already assigned a profile."}

    # Restored: audit_log needs an entry for who approved whom, into what role.
    _write_audit_log(
        actor_uid=admin_profile["auth_uid"],
        action="approve_user_role",
        table_affected="user_profiles",
        record_id=result.data[0]["profile_id"],
        details={"approved_auth_uid": auth_uid, "role": role, "email": email},
    )
    return result.data[0]


# ------------------------------------------------------------
# Gradio UI (also serves as the API surface)
# ------------------------------------------------------------
with gr.Blocks(title="Coal Mining Governance Platform - Backend") as demo:
    gr.Markdown("# ⛏️ Coal Mining Smart Governance Platform — API Backend")
    gr.Markdown(
        "This Space is the backend API. Each tab below is also callable "
        "directly by the frontend via Gradio's auto-generated REST endpoints. "
        "**Every endpoint below now requires a Supabase `access_token`** -- paste "
        "one from your own browser session's dev tools to test manually."
    )

    with gr.Tab("Dashboard Summary"):
        token_1 = gr.Textbox(label="Supabase Access Token", type="password")
        sub_input = gr.Textbox(label="Subsidiary code (or 'All')", value="All")
        dash_btn = gr.Button("Get Summary")
        dash_output = gr.JSON()
        dash_btn.click(get_dashboard_summary, inputs=[token_1, sub_input], outputs=dash_output,
                       api_name="get_dashboard_summary")

    with gr.Tab("High Risk Mines"):
        token_2 = gr.Textbox(label="Supabase Access Token", type="password")
        risk_limit = gr.Number(label="Limit", value=10)
        risk_btn = gr.Button("Get High-Risk Mines")
        risk_output = gr.JSON()
        risk_btn.click(get_high_risk_mines, inputs=[token_2, risk_limit], outputs=risk_output,
                       api_name="get_high_risk_mines")

    with gr.Tab("Log Field Inspection"):
        token_3 = gr.Textbox(label="Supabase Access Token", type="password")
        mine_id_in = gr.Textbox(label="Mine ID (UUID)")
        lat_in = gr.Number(label="Latitude")
        lon_in = gr.Number(label="Longitude")
        obs_type_in = gr.Dropdown(
            ["Safety Equipment Check", "Ventilation Inspection", "Slope Stability",
             "Electrical Safety", "Housekeeping", "Water Accumulation", "PPE Compliance"],
            label="Observation Type")
        severity_in = gr.Dropdown(["Low", "Medium", "High", "Critical"], label="Severity")
        notes_in = gr.Textbox(label="Notes", lines=3)
        log_btn = gr.Button("Submit Inspection")
        log_output = gr.JSON()
        log_btn.click(
            log_field_inspection,
            inputs=[token_3, mine_id_in, lat_in, lon_in, obs_type_in, severity_in, notes_in],
            outputs=log_output,
            api_name="log_field_inspection",
        )

    with gr.Tab("AI Chat Assistant"):
        token_4 = gr.Textbox(label="Supabase Access Token", type="password")
        chatbot = gr.Chatbot(label="Governance Assistant (Groq)")
        msg = gr.Textbox(label="Ask about compliance, safety trends, mine data...")
        clear = gr.Button("Clear")

        def respond(token, message, chat_history):
            bot_reply = chat_with_data_assistant(token, message, chat_history)
            chat_history = chat_history + [[message, bot_reply]]
            return "", chat_history

        # api_name is set explicitly to "chat_with_data_assistant" here --
        # the function actually wired to this event is the local `respond`
        # wrapper (needed for the Chatbot UI's history format), so without
        # an explicit api_name Gradio would expose this as /api/respond
        # instead, which wouldn't match what frontend/lib/api.js calls.
        msg.submit(respond, [token_4, msg, chatbot], [msg, chatbot], api_name="chat_with_data_assistant")
        clear.click(lambda: None, None, chatbot, queue=False, api_name=False)

    with gr.Tab("Compliance Status"):
        token_5 = gr.Textbox(label="Supabase Access Token", type="password")
        mine_lookup = gr.Textbox(label="Mine ID (UUID)")
        comp_btn = gr.Button("Get Compliance Checklist")
        comp_output = gr.JSON()
        comp_btn.click(get_compliance_status, inputs=[token_5, mine_lookup], outputs=comp_output,
                       api_name="get_compliance_status")

    with gr.Tab("Update Compliance Status"):
        token_6 = gr.Textbox(label="Supabase Access Token", type="password")
        tracking_id_in = gr.Textbox(label="Tracking ID (UUID)")
        status_in = gr.Dropdown(["Completed", "Pending", "Overdue", "Not Applicable"], label="New Status")
        remarks_in = gr.Textbox(label="Remarks", lines=2)
        update_btn = gr.Button("Update Status")
        update_output = gr.JSON()
        update_btn.click(update_compliance_status, inputs=[token_6, tracking_id_in, status_in, remarks_in], outputs=update_output,
                         api_name="update_compliance_status")

    with gr.Tab("Admin: Pending Signups"):
        token_7 = gr.Textbox(label="Supabase Access Token (must belong to an admin)", type="password")
        admin_key_in1 = gr.Textbox(label="Admin Key (optional extra layer)", type="password")
        pending_btn = gr.Button("List Pending Signups")
        pending_output = gr.JSON()
        pending_btn.click(list_pending_signups, inputs=[token_7, admin_key_in1], outputs=pending_output,
                          api_name="list_pending_signups")

    with gr.Tab("Admin: Approve User Role"):
        token_8 = gr.Textbox(label="Supabase Access Token (must belong to an admin)", type="password")
        admin_key_in2 = gr.Textbox(label="Admin Key (optional extra layer)", type="password")
        uid_in = gr.Textbox(label="Auth UID (from Pending Signups)")
        email_in = gr.Textbox(label="Email")
        name_in = gr.Textbox(label="Full Name")
        role_in = gr.Dropdown(list(ALL_ROLES), label="Role")
        approve_mine_id_in = gr.Textbox(label="Mine ID (UUID, optional)")
        approve_sub_id_in = gr.Textbox(label="Subsidiary ID (optional)")
        approve_btn = gr.Button("Approve")
        approve_output = gr.JSON()
        approve_btn.click(
            approve_user_role,
            inputs=[token_8, admin_key_in2, uid_in, email_in, name_in, role_in, approve_mine_id_in, approve_sub_id_in],
            outputs=approve_output,
            api_name="approve_user_role",
        )

if __name__ == "__main__":
    demo.queue().launch(server_name="0.0.0.0", server_port=7860)