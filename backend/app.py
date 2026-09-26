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

# MODEL UPDATE: this used to default to "llama-3.3-70b-versatile", which
# Groq deprecated on 2026-06-17 and DECOMMISSIONED on 2026-08-16 -- calls
# to it are now rejected outright with a model_decommissioned error, which
# surfaced here as a bare HTTP 500. Groq's recommended replacement for that
# model is openai/gpt-oss-120b. Overridable via the GROQ_MODEL env var so a
# future migration needs no code change.
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")


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


def _rate_limited_local(key: str, max_calls: int, window_seconds: int) -> bool:
    now = time.time()
    calls = [t for t in _rate_state[key] if now - t < window_seconds]
    calls.append(now)
    _rate_state[key] = calls
    return len(calls) > max_calls


def _rate_limited(key: str, max_calls: int, window_seconds: int) -> bool:
    """Shared rate limit, kept in the database (migration 10), so it holds
    across restarts and across any number of backend instances. If the
    database call fails -- migration not run, a network hiccup -- this
    falls back to the per-process limiter rather than refusing everyone."""
    if supabase:
        try:
            res = supabase.rpc("hit_rate_limit", {
                "p_key": key, "p_max": max_calls, "p_window_seconds": window_seconds,
            }).execute()
            if isinstance(res.data, bool):
                return res.data
        except Exception:
            pass
    return _rate_limited_local(key, max_calls, window_seconds)


# ------------------------------------------------------------
# 1. DASHBOARD SUMMARY -- corporate/regulator overview
# ------------------------------------------------------------
def get_dashboard_summary(access_token: str, subsidiary_filter: str = "All"):
    """Aggregate KPIs for the oversight dashboards.

    Every figure honours the subsidiary filter. Previously only the mine
    count did -- the fatal-accident and overdue figures stayed national
    whatever was selected, so a filtered dashboard quietly mixed one
    subsidiary's mine count with the whole country's problems.
    Requires a valid login (any role) -- this is business/safety data."""
    if not supabase:
        return {"error": "Supabase not configured yet. Set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY."}

    uid, profile, err = _authenticate(access_token)
    if err:
        return err

    sid = None
    if subsidiary_filter and subsidiary_filter != "All":
        sub = supabase.table("subsidiaries").select("subsidiary_id").eq(
            "subsidiary_code", subsidiary_filter).execute().data
        if not sub:
            return {"error": f"Unknown subsidiary '{subsidiary_filter}'."}
        sid = sub[0]["subsidiary_id"]

    def count(table, select, *filters, via_mine=False):
        """Exact row count. Tables without their own subsidiary column are
        filtered through an inner join to mines."""
        q = supabase.table(table).select(select + (", mines!inner(subsidiary_id)" if via_mine and sid else ""),
                                         count="exact")
        for f in filters:
            q = f(q)
        if sid is not None:
            q = q.eq("mines.subsidiary_id", sid) if via_mine else q.eq("subsidiary_id", sid)
        try:
            return q.limit(1).execute().count or 0
        except Exception:
            return None   # a missing table/view (migration not run) shows as a dash, not a crash

    since = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    today = datetime.date.today().isoformat()
    return {
        "total_mines": count("mines", "mine_id"),
        "fatal_accidents_recorded": count("accidents", "accident_id", lambda q: q.eq("severity", "Fatal")),
        "overdue_compliance_items": count("compliance_tracking", "tracking_id",
                                          lambda q: q.eq("status", "Overdue"), via_mine=True),
        "overdue_corrective_actions": count("corrective_action_view", "inspection_id",
                                            lambda q: q.neq("corrective_action_status", "Closed"),
                                            lambda q: q.lt("action_due_date", today)),
        "awaiting_verification": count("corrective_action_view", "inspection_id",
                                       lambda q: q.eq("corrective_action_status", "Action Taken")),
        "incidents_last_30_days": count("incident_view", "incident_id",
                                        lambda q: q.gte("occurred_at", since)),
        "dgms_notices_overdue": count("incident_view", "incident_id",
                                      lambda q: q.eq("notice_overdue", True)),
        "returns_awaiting_approval": count("statutory_return_view", "return_id",
                                           lambda q: q.eq("status", "Submitted")),
        "filter_applied": subsidiary_filter or "All",
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
        "mine_id, risk_score, flag_type, explanation, response_status, response_note"
    ).order("risk_score", desc=True).limit(limit).execute().data

    if not flags:
        return {"message": "No risk flags generated yet. Run the analytics job first."}

    # Attach human-readable mine names. Without this the UI can only show
    # raw uuids, which tell a reader nothing. Done as one batched lookup
    # keyed by the ids we actually got back, rather than a per-row query.
    mine_ids = list({f["mine_id"] for f in flags if f.get("mine_id")})
    names = {}
    if mine_ids:
        try:
            rows = supabase.table("mines").select(
                "mine_id, mine_name, state"
            ).in_("mine_id", mine_ids).execute().data
            names = {r["mine_id"]: r for r in rows}
        except Exception:
            pass  # names are a nicety; still return the flags without them

    for f in flags:
        m = names.get(f.get("mine_id"))
        f["mine_name"] = m["mine_name"] if m else None
        f["state"] = m.get("state") if m else None

    return flags


# ------------------------------------------------------------
# 3. LOG A FIELD INSPECTION -- called from the Inspector web dashboard
#    (frontend/pages/dashboard/inspector.js submits a form; browser
#    geolocation API supplies latitude/longitude -- no native app needed)
# ------------------------------------------------------------
def log_field_inspection(access_token: str, mine_id: str, latitude: float,
                          longitude: float, observation_type: str,
                          severity: str, notes: str = "",
                          photo_url: str = "", captured_at: str = ""):
    """Records a geo-tagged inspection.

    inspector_id is derived from the caller's verified identity, never from
    the request, so nobody can file under someone else's name. Only
    inspectors, mine officials, contractor managers and admins may log, and
    mine-scoped roles only at their own mine.

    captured_at: when the inspection was recorded on the device. An
    inspection queued offline used to be stamped with the time it SYNCED,
    which could be hours after it was made -- wrong on a statutory record.
    A device time is accepted if it lies in the last 72 hours and not in
    the future; otherwise the server time is used.

    photo_url: storage path of the photo taken at the face (evidence
    bucket, uploaded by the client under <mine_id>/...). Optional.

    The response includes the database's geo-fence verdict, so the
    inspector is told at once if their position does not match the mine."""
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

    try:
        latitude, longitude = float(latitude), float(longitude)
    except (TypeError, ValueError):
        return {"error": "latitude/longitude must be numbers."}
    if not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
        return {"error": "latitude/longitude out of valid range."}
    if severity not in ("Low", "Medium", "High", "Critical"):
        return {"error": "severity must be Low, Medium, High or Critical."}

    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = now
    if captured_at:
        try:
            claimed = datetime.datetime.fromisoformat(str(captured_at).replace("Z", "+00:00"))
            if claimed.tzinfo is None:
                claimed = claimed.replace(tzinfo=datetime.timezone.utc)
            if now - datetime.timedelta(hours=72) <= claimed <= now + datetime.timedelta(minutes=5):
                stamp = claimed
        except ValueError:
            pass

    # Evidence must sit in this mine's folder of the private bucket. A path
    # pointing anywhere else is dropped rather than trusted.
    photo = (photo_url or "").strip() or None
    if photo and not photo.startswith(f"{mine_id}/"):
        photo = None

    row = {
        "mine_id": mine_id,
        # geo_inspections.inspector_id references user_profiles(profile_id)
        # -- not the auth uid -- and the RLS policy compares against it too.
        "inspector_id": profile["profile_id"],
        "timestamp": stamp.isoformat(),
        "latitude": latitude,
        "longitude": longitude,
        "observation_type": observation_type,
        "severity": severity,
        "notes": notes,
        "photo_url": photo,
        "is_synthetic": False,
    }
    result = supabase.table("geo_inspections").insert(row).execute()
    saved = (result.data or [{}])[0]
    return {
        "status": "logged",
        "inspection": result.data,
        "within_geofence": saved.get("within_geofence"),
        "distance_from_mine_m": saved.get("distance_from_mine_m"),
        "action_due_date": saved.get("action_due_date"),
        "backdated_from_device": stamp != now,
    }


# ------------------------------------------------------------
# 4. AI CHAT / INSIGHTS -- Groq-powered assistant
# ------------------------------------------------------------
def _clip(text, n):
    """Shortens free text for the prompt; the model needs the gist, not the essay."""
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _mine_names(ids):
    """mine_id -> {mine_name, state} for a set of ids, in one query."""
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    try:
        rows = supabase.table("mines").select("mine_id, mine_name, state").in_("mine_id", ids).execute().data or []
        return {r["mine_id"]: r for r in rows}
    except Exception:
        return {}


def _build_chat_context(profile: dict) -> str:
    """Assembles the live data snapshot handed to the model.

    Everything here is SCOPED BY ROLE and mirrors the RLS policies in
    supabase/: oversight roles (corporate_admin / regulator / admin) see
    across all mines; mine-attached roles see only their own mine. The
    backend queries with the service-role key, so this function IS the
    access control for the assistant -- anything included here is
    something the model can repeat back to the user.

    Two fixes over the previous version:
      * Mine scoping is applied IN THE QUERY. Risk flags and contractor
        documents used to be fetched as a national top-N and then filtered
        to the user's mine, so a mine outside the national top 8 got an
        empty list and the assistant said there were no findings.
      * Grievances follow the same privacy rule as the database: a worker
        sees only what they filed, and only the mine official and
        oversight see a mine's grievances. Previously any worker at a mine
        could ask the assistant to read out colleagues' complaints.

    Row counts are capped -- this is a prompt, not a report.
    """
    if not supabase:
        return ""

    role = profile.get("role")
    mine_id = profile.get("mine_id")
    wide = role in ("corporate_admin", "regulator", "admin")
    if not wide and not mine_id:
        return ("\n\nDATA SNAPSHOT: this user has no mine assigned, so there is no "
                "mine data they are allowed to see. Say so if asked about a mine.")

    parts = []
    today = datetime.date.today()

    def scoped(query):
        return query if wide else query.eq("mine_id", mine_id)

    def section(fn):
        try:
            text = fn()
            if text:
                parts.append(text)
        except Exception:
            pass   # one unavailable source must not silence the rest

    def label(names, mid):
        m = names.get(mid) or {}
        return f"{m.get('mine_name', 'Unknown mine')} ({m.get('state', '?')})"

    def totals():
        t = {
            "overdue_compliance_items": scoped(supabase.table("compliance_tracking").select(
                "tracking_id", count="exact").eq("status", "Overdue")).limit(1).execute().count or 0,
        }
        if wide:
            t["mines"] = supabase.table("mines").select("mine_id", count="exact").limit(1).execute().count or 0
            t["fatal_accidents_on_record"] = supabase.table("accidents").select(
                "accident_id", count="exact").eq("severity", "Fatal").limit(1).execute().count or 0
        return f"Totals: {json.dumps(t)}"

    def flags():
        rows = scoped(supabase.table("ai_risk_flags").select(
            "mine_id, risk_score, flag_type, explanation, response_status, response_note")
        ).order("risk_score", desc=True).limit(12 if wide else 8).execute().data or []
        if not rows:
            return "Risk flags: none raised" + ("." if wide else " against this mine.")
        names = _mine_names(r["mine_id"] for r in rows)
        return "Risk flags (highest first):\n" + "\n".join(
            f"- {label(names, f['mine_id'])}: {f['flag_type']}, risk {f['risk_score']}. "
            f"{_clip(f.get('explanation'), 220)} Mine's response: {f.get('response_status') or 'Open'}"
            + (f" — {_clip(f['response_note'], 120)}" if f.get("response_note") else "")
            for f in rows)

    def overdue_breadth():
        if not wide:
            return None
        # Paged: PostgREST returns at most 1,000 rows per request, and a
        # single capped request undercounted the mines affected.
        agg, page = [], 0
        while True:
            chunk = supabase.table("compliance_tracking").select("mine_id").eq(
                "status", "Overdue").range(page * 1000, page * 1000 + 999).execute().data or []
            agg.extend(chunk)
            if len(chunk) < 1000 or page >= 30:
                break
            page += 1
        counts = {}
        for r in agg:
            counts[r["mine_id"]] = counts.get(r["mine_id"], 0) + 1
        top = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:10]
        if not top:
            return None
        names = _mine_names(m for m, _ in top)
        return (f"Overdue compliance by mine ({len(counts)} mines affected; showing the {len(top)} worst):\n"
                + "\n".join(f"- {label(names, mid)}: {c} overdue items" for mid, c in top))

    def overdue_sample():
        rows = scoped(supabase.table("compliance_tracking").select(
            "mine_id, due_date, statutory_compliance_items(requirement_summary, category, regulation_source)"
        ).eq("status", "Overdue")).order("due_date").limit(10).execute().data or []
        if not rows:
            return None
        names = _mine_names(r["mine_id"] for r in rows)
        return ("SAMPLE of overdue obligations, oldest first (not the full list):\n" + "\n".join(
            f"- {label(names, o['mine_id'])}: {(o.get('statutory_compliance_items') or {}).get('category', '?')} | "
            f"due {o.get('due_date')} | {(o.get('statutory_compliance_items') or {}).get('regulation_source', '')} — "
            f"{(o.get('statutory_compliance_items') or {}).get('requirement_summary', '')}"
            for o in rows))

    def predictions():
        rows = scoped(supabase.table("compliance_prediction_view").select(
            "mine_name, state, requirement_summary, regulation_source, due_date, probability, top_factors")
        ).order("probability", desc=True).limit(10).execute().data or []
        if not rows:
            return None
        return ("PREDICTED to slip (model estimate, pending items not yet overdue):\n" + "\n".join(
            f"- {r['mine_name']} ({r['state']}): {r['requirement_summary']} due {r['due_date']}, "
            f"{round(float(r['probability']) * 100)}% likely to be missed. Main factors: "
            + ", ".join(f.get("factor", "") for f in (r.get("top_factors") or [])[:3])
            for r in rows))

    def actions():
        rows = scoped(supabase.table("corrective_action_view").select(
            "mine_name, state, observation_type, severity, corrective_action_status, action_due_date, "
            "days_left, within_geofence, reopened_count, notes")
        ).neq("corrective_action_status", "Closed").order("action_due_date").limit(12).execute().data or []
        if not rows:
            return "Corrective actions: every inspection finding is closed."
        return ("Open inspection findings and their corrective action (earliest deadline first):\n" + "\n".join(
            f"- {r['mine_name']}: {r['observation_type']} ({r['severity']}), status {r['corrective_action_status']}, "
            f"action due {r['action_due_date']}"
            + (f" — {abs(r['days_left'])} days late" if (r.get("days_left") or 0) < 0 else "")
            + (f", reopened {r['reopened_count']}x after failed verification" if r.get("reopened_count") else "")
            + (", RECORDED OUTSIDE THE MINE GEO-FENCE" if r.get("within_geofence") is False else "")
            + f". {_clip(r.get('notes'), 120)}".rstrip()
            for r in rows))

    def incidents():
        since = (today - datetime.timedelta(days=90)).isoformat()
        rows = scoped(supabase.table("incident_view").select(
            "mine_name, state, incident_type, severity, occurred_at, status, persons_killed, persons_injured, "
            "notifiable, dgms_notified, notice_overdue, root_cause")
        ).gte("occurred_at", since).order("occurred_at", desc=True).limit(12).execute().data or []
        if not rows:
            return "Incidents in the last 90 days: none reported."
        return ("Incidents in the last 90 days:\n" + "\n".join(
            f"- {r['occurred_at'][:10]} {r['mine_name']}: {r['incident_type']} ({r['severity']}), "
            f"{r['persons_killed']} killed / {r['persons_injured']} injured, status {r['status']}"
            + (", DGMS NOTICE OVERDUE" if r.get("notice_overdue") else
               (", DGMS notified" if r.get("dgms_notified") else (", DGMS notice pending" if r.get("notifiable") else "")))
            + (f", root cause: {r['root_cause']}" if r.get("root_cause") else "")
            for r in rows))

    def environment():
        since = (today - datetime.timedelta(days=30)).isoformat()
        rows = scoped(supabase.table("env_readings").select(
            "mine_id, reading_date, parameter, value, limit_max, limit_min, station_label")
        ).eq("exceeds_limit", True).gte("reading_date", since).order("reading_date", desc=True).limit(12).execute().data or []
        if not rows:
            return None
        names = _mine_names(r["mine_id"] for r in rows)
        return ("Environmental readings above statutory limits (last 30 days):\n" + "\n".join(
            f"- {r['reading_date']} {label(names, r['mine_id'])}: {r['parameter']} {r['value']} "
            f"(limit {r.get('limit_max') if r.get('limit_max') is not None else 'min ' + str(r.get('limit_min'))})"
            + (f" at {r['station_label']}" if r.get("station_label") else "")
            for r in rows))

    def production():
        since = (today - datetime.timedelta(days=30)).isoformat()
        rows = scoped(supabase.table("production_anomaly_view").select(
            "mine_id, production_date, produced_t, target_t, z_score, pct_of_target, is_anomaly")
        ).gte("production_date", since).order("production_date", desc=True).limit(400).execute().data or []
        if not rows:
            return None
        names = _mine_names(r["mine_id"] for r in rows)
        total = sum(float(r["produced_t"] or 0) for r in rows)
        target = sum(float(r["target_t"] or 0) for r in rows)
        odd = [r for r in rows if r.get("is_anomaly")][:8]
        text = (f"Production, last 30 days: {round(total):,} t reported against a target of {round(target):,} t"
                + (f" ({round(100 * total / target, 1)}%)" if target else "") + ".")
        if odd:
            text += "\nDays flagged as anomalous (z-score vs the mine's trailing 30 days):\n" + "\n".join(
                f"- {r['production_date']} {label(names, r['mine_id'])}: {r['produced_t']} t, z = {r['z_score']}"
                for r in odd)
        return text

    def attendance():
        if role not in ("corporate_admin", "regulator", "admin", "mine_official", "inspector"):
            return None
        since = (today - datetime.timedelta(days=7)).isoformat()
        rows = scoped(supabase.table("attendance_checkins").select(
            "mine_id, check_in_within_geofence, check_out_within_geofence")
        ).gte("check_in_at", since).limit(5000).execute().data or []
        if not rows:
            return None
        exc = sum(1 for r in rows if r.get("check_in_within_geofence") is False
                  or r.get("check_out_within_geofence") is False)
        return f"Attendance, last 7 days: {len(rows)} check-ins, {exc} recorded outside the mine geo-fence."

    def grievances():
        if role == "worker":
            rows = supabase.table("grievances").select("category, status, date_filed, resolution_note").eq(
                "filed_by", profile.get("profile_id")).order("date_filed", desc=True).limit(10).execute().data or []
            if not rows:
                return "This worker has not filed any grievances."
            return ("Grievances THIS USER filed (they may see only their own):\n" + "\n".join(
                f"- {g['date_filed']} {g['category']}: {g['status']}"
                + (f" — outcome: {g['resolution_note']}" if g.get("resolution_note") else "")
                for g in rows))
        if not (wide or role == "mine_official"):
            return None   # other mine roles may not read colleagues' grievances
        rows = scoped(supabase.table("grievance_status_view").select(
            "mine_id, category, status, date_filed, priority, is_overdue, days_remaining")
        ).neq("status", "Resolved").order("date_filed", desc=True).limit(12).execute().data or []
        if not rows:
            return None
        names = _mine_names(r["mine_id"] for r in rows)
        # Categories and deadlines only: the complaint text itself stays out
        # of the prompt, as it stays out of the audit trail.
        return ("Open grievances (category and deadline only):\n" + "\n".join(
            f"- {label(names, g['mine_id'])}: {g['category']} ({g.get('priority') or 'unprioritised'}), "
            f"filed {g['date_filed']}, {g['status']}"
            + (f", {abs(g.get('days_remaining') or 0)} days past deadline" if g.get("is_overdue") else "")
            for g in rows))

    def contractor_docs():
        rows = scoped(supabase.table("contractor_compliance_view").select(
            "contractor_name, document_type, computed_status, days_to_expiry")
        ).in_("computed_status", ["Expired", "Expiring", "Missing"]).order(
            "days_to_expiry", nullsfirst=True).limit(12).execute().data or []
        if not rows:
            return None
        return ("Contractor documents needing attention (sample):\n" + "\n".join(
            f"- {d['contractor_name']}: {d['document_type']} — {d['computed_status']}"
            + (f", {abs(d['days_to_expiry'])} days {'overdue' if d['days_to_expiry'] < 0 else 'left'}"
               if d.get("days_to_expiry") is not None else "")
            for d in rows))

    def contractors_ctx():
        if role not in ("mine_official", "contractor_manager", "inspector", "corporate_admin", "regulator", "admin"):
            return None
        parts_c = []
        try:
            waiting = scoped(supabase.table("contractor_register_view").select(
                "contractor_name, document_gaps").eq("status", "Under Review")).limit(20).execute().data or []
            if waiting:
                parts_c.append("Contractors awaiting approval to work:\n" + "\n".join(
                    f"- {w['contractor_name']}" + (f" (missing or lapsed: {', '.join(w['document_gaps'])})"
                                                   if w.get("document_gaps") else " (documents complete)")
                    for w in waiting))
        except Exception:
            pass
        try:
            since = (today - datetime.timedelta(days=14)).isoformat()
            crews = scoped(supabase.table("crew_attendance_view").select(
                "contractor_name, attendance_date, shift, headcount, lapsed_documents"
            ).eq("documents_lapsed", True).gte("attendance_date", since)).order(
                "attendance_date", desc=True).limit(10).execute().data or []
            if crews:
                parts_c.append("Contract crews worked under lapsed documents (last 14 days):\n" + "\n".join(
                    f"- {c['attendance_date']} shift {c['shift']}: {c['contractor_name']}, {c['headcount']} workers, "
                    f"lapsed {', '.join(c.get('lapsed_documents') or [])}" for c in crews))
        except Exception:
            pass
        return "\n\n".join(parts_c) or None

    def repeat_failures():
        try:
            rows = scoped(supabase.table("obligation_track_record_view").select(
                "mine_id, requirement_summary, periods, missed, miss_rate"
            ).gte("missed", 2).gte("miss_rate", 0.5)).order("missed", desc=True).limit(12).execute().data or []
        except Exception:
            return None
        if not rows:
            return None
        names = _mine_names(r["mine_id"] for r in rows)
        return ("Obligations missed again and again (last 12 months):\n" + "\n".join(
            f"- {label(names, r['mine_id'])}: {_clip(r['requirement_summary'], 110)} (missed {r['missed']} of {r['periods']})"
            for r in rows))

    def returns():
        if not (wide or role == "mine_official"):
            return None
        q = scoped(supabase.table("statutory_return_view").select(
            "mine_name, return_type, period_start, status, review_note, submission_due"))
        if role == "regulator":
            q = q.eq("status", "Approved")
        rows = q.order("period_start", desc=True).limit(10).execute().data or []
        if not rows:
            return None
        return ("Statutory returns:\n" + "\n".join(
            f"- {r['mine_name']}: {r['return_type']} for {str(r['period_start'])[:7]} — {r['status']}"
            + (f" (sent back: {r['review_note']})" if r.get("status") == "Returned" and r.get("review_note") else "")
            + (f" -- OVERDUE, was due by {r['submission_due']}"
               if r.get("status") in ("Draft", "Returned") and r.get("submission_due")
               and r["submission_due"] < today.isoformat() else "")
            for r in rows))

    for fn in (totals, flags, overdue_breadth, overdue_sample, repeat_failures, predictions, actions, incidents,
               environment, production, attendance, grievances, contractor_docs, contractors_ctx, returns):
        section(fn)

    scope_note = ("You can see data across ALL mines."
                  if wide else "You can only see data for this user's own assigned mine.")
    truncation_note = (
        "Lists below are capped for length. Where a total is given, trust the "
        "total over the number of rows you can see, and never describe a list "
        "as complete or exhaustive unless a total confirms it.")
    return ("\n\nDATA SNAPSHOT (live, already access-filtered, as of " + today.isoformat() + "). "
            + scope_note + " " + truncation_note + "\n" + "\n\n".join(parts))


SYSTEM_PROMPT = """You are the AI assistant embedded in a Smart Governance Platform
for Indian coal mining operations, used by mine officials, corporate management,
regulators, inspectors and workers.

You are given a DATA SNAPSHOT below, pulled live from the platform database and
already filtered to what this particular user is allowed to see. Treat it as
ground truth.

How to answer:
- Name specific mines, states, figures and dates from the snapshot. Do not give
  a generic answer when the snapshot contains the actual records.
- Go beyond restating rows: compare mines against each other, point out which
  numbers are unusual and why, connect a compliance gap to the accident or
  environmental record at the same site, and say what it implies.
- Lead with the direct answer, then the reasoning behind it, then what the user
  should do about it. Reference the specific regulation or requirement where the
  snapshot gives you one.
- Quantify where you can ("5 fatal accidents against a 1.59 average") rather
  than saying "several" or "a high number".
- If the snapshot genuinely lacks what was asked, say exactly which field is
  missing and answer as far as the data allows -- do not invent mine names,
  figures or dates under any circumstances.
- Lists in the snapshot are capped samples, not complete extracts. Never say
  a list is exhaustive or that "no other mine appears" -- if a total is given
  alongside a sample, cite the total for breadth and treat the named rows as
  examples. Saying "the worst affected are X and Y, out of N mines with
  overdue items" is correct; saying "only X has overdue items" is not.
- Write in plain prose for a busy official. A short list is fine when the answer
  really is a list; avoid heavy nested formatting.

LANGUAGE
Reply in the same language the user wrote in. Indian coalfields are worked by
people who speak Hindi, Bengali, Odia, Telugu and Jharkhandi languages, and a
worker asking about their safety entitlements in Hindi should get the answer in
Hindi. Keep statutory names, regulation numbers and mine names in their official
form -- translate the explanation, not the identifiers, because a worker who has
to raise the matter with an official needs the term the official will recognise.
If a question mixes languages, follow the one the question is mostly written in."""


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

    context = _build_chat_context(profile)

    messages = [{"role": "system", "content": SYSTEM_PROMPT + context}]
    if history:
        for turn in history:
            messages.append({"role": "user", "content": turn[0]})
            messages.append({"role": "assistant", "content": turn[1]})
    messages.append({"role": "user", "content": user_message})

    # Wrapped so an API-side failure (bad key, decommissioned model, rate
    # limit, outage) comes back as a readable message in the chat instead of
    # an unhandled exception that Gradio turns into an opaque HTTP 500.
    try:
        response = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages,
            # Slightly higher temperature and a bigger budget than the
            # original 0.3/800: the assistant is now expected to compare
            # sites and explain reasoning, not just restate a figure, and
            # answers were getting truncated mid-analysis at 800.
            temperature=0.4,
            max_tokens=1600,
        )
        return response.choices[0].message.content
    except Exception as e:
        return (
            f"The assistant is unavailable right now ({type(e).__name__}: {e}). "
            f"Model in use: {GROQ_MODEL}. If this mentions a decommissioned "
            f"model, set the GROQ_MODEL secret on the Space to a current one."
        )


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
def update_compliance_status(access_token: str, tracking_id: str, new_status: str, remarks: str = "",
                             evidence_url: str = ""):
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

    # Evidence of completion (a challan, a test certificate, a photo) is
    # stored in the private evidence bucket under the mine's own folder.
    # A path outside that folder is refused rather than trusted.
    evidence = (evidence_url or "").strip() or None
    if evidence and not evidence.startswith(f"{existing[0]['mine_id']}/"):
        return {"error": "Evidence must be uploaded to this mine's folder."}

    update_values = {
        "status": new_status,
        "remarks": remarks or None,
        "completed_date": datetime.date.today().isoformat() if new_status == "Completed" else None,
        "submitted_by": profile["profile_id"],
    }
    if evidence:
        update_values["evidence_url"] = evidence
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
        details={"new_status": new_status, "remarks": remarks, "evidence": bool(evidence),
                 "mine_id": existing[0]["mine_id"]},
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
        photo_in = gr.Textbox(label="Photo storage path (optional, <mine_id>/...)")
        captured_in = gr.Textbox(label="Captured at, ISO time (optional, for offline records)")
        log_btn = gr.Button("Submit Inspection")
        log_output = gr.JSON()
        log_btn.click(
            log_field_inspection,
            inputs=[token_3, mine_id_in, lat_in, lon_in, obs_type_in, severity_in, notes_in,
                    photo_in, captured_in],
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
        # The UI event and the REST endpoint are deliberately separate now.
        #
        # `respond` exists for the Chatbot widget and returns TWO outputs:
        # ("", updated_history) -- the empty string clears the input box.
        # When this event carried api_name="chat_with_data_assistant", the
        # REST response was {"data": ["", [[...]]]} and lib/api.js, which
        # reads data[0], got that empty string instead of the reply. The
        # chat looked like it answered with nothing.
        #
        # So the UI event is now excluded from the API (api_name=False), and
        # the endpoint below is bound to chat_with_data_assistant directly,
        # which returns a single string. Hidden components exist only to
        # give the event something to bind to.
        msg.submit(respond, [token_4, msg, chatbot], [msg, chatbot], api_name=False)

        api_chat_in = gr.Textbox(visible=False)
        api_chat_out = gr.Textbox(visible=False)
        api_chat_btn = gr.Button(visible=False)
        api_chat_btn.click(
            chat_with_data_assistant,
            inputs=[token_4, api_chat_in, chatbot],
            outputs=api_chat_out,
            api_name="chat_with_data_assistant",
        )
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
        evidence_in = gr.Textbox(label="Evidence storage path (optional, <mine_id>/...)")
        update_btn = gr.Button("Update Status")
        update_output = gr.JSON()
        update_btn.click(update_compliance_status, inputs=[token_6, tracking_id_in, status_in, remarks_in, evidence_in],
                         outputs=update_output,
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
    # api_open=True is REQUIRED for the frontend to work.
    #
    # Gradio's built-in REST route (POST /api/<api_name>) is gated behind
    # the queue's `api_open` flag. When it is False -- which it can default
    # to once demo.queue() is enabled, and which is what a Hugging Face
    # Space was doing here -- Gradio answers a perfectly valid, registered
    # endpoint with a bare 404. That is indistinguishable from "wrong URL"
    # from the caller's side: GET still returns 405 Method Not Allowed
    # (proving the path exists), while POST returns 404.
    #
    # Setting it True explicitly opens the REST API to the Vercel frontend.
    # Security is unaffected: every function verifies the caller's Supabase
    # token and role itself (see _authenticate), and the RLS policies in
    # supabase/schema.sql enforce access at the database layer too. The
    # endpoints were never relying on being hard to reach.
    demo.queue(api_open=True).launch(server_name="0.0.0.0", server_port=7860)