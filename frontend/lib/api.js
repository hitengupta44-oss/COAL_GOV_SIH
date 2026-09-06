// Calls the backend (deployed on Hugging Face Spaces).
//
// URL: this posts to Gradio's built-in synchronous REST route,
// /api/<function_name>. Note this is NOT the old Gradio 3.x
// /run/<function_name> path (removed in Gradio 4.x -- calling it returns
// 404), nor the newer queue-based /gradio_api/call/<name> + SSE flow.
// Each backend event sets api_name="..." explicitly so these names stay
// stable; keep them in sync with backend/app.py.
//
// AUTH: every function below takes accessToken as its FIRST argument,
// matching backend/app.py's _authenticate(access_token) on every endpoint.
// Get it from useAuth()'s getAccessToken() right before calling -- the
// Supabase client auto-refreshes near expiry, so read it fresh rather
// than caching it yourself.

// The env var still wins if it's set, but there's a hardcoded fallback so
// the app works even when NEXT_PUBLIC_BACKEND_URL doesn't make it into the
// build. That happens more easily than you'd think: NEXT_PUBLIC_* values
// are compiled in at BUILD time, so setting one in Vercel and not
// redeploying leaves it undefined. When it's undefined the template below
// produces "undefined/api/foo", which the browser resolves as a RELATIVE
// path against the Vercel domain -- so the request never reaches the Space
// and Next.js answers it with a 404 that looks like a backend failure.
//
// Change the fallback if you move the Space. No trailing slash.
const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "https://beastzzz-coal-gov.hf.space";

// Trailing slashes are stripped so a value like "https://x.hf.space/"
// doesn't produce a double-slash URL that 404s.
const BASE = String(BACKEND_URL).replace(/\/+$/, "");

async function callBackend(fnName, args = []) {
  const url = `${BASE}/api/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: args }),
  });
  // The URL is included in the error on purpose: a bare status code can't
  // distinguish "the Space returned 404" from "we called the wrong host and
  // Vercel returned 404", and those need opposite fixes.
  if (!res.ok) {
    throw new Error(`Backend call failed: ${fnName} (${res.status}) at ${url}`);
  }
  const json = await res.json();
  return json.data ? json.data[0] : json;
}

export const getDashboardSummary = (accessToken, subsidiaryFilter = "All") =>
  callBackend("get_dashboard_summary", [accessToken, subsidiaryFilter]);

export const getHighRiskMines = (accessToken, limit = 10) =>
  callBackend("get_high_risk_mines", [accessToken, limit]);

// NOTE: inspectorId is no longer sent -- the backend derives the inspector's
// identity from their own verified accessToken (see log_field_inspection's
// SECURITY FIX comment in app.py), so a caller can't log an inspection
// under someone else's name.
export const logFieldInspection = (accessToken, payload) =>
  callBackend("log_field_inspection", [
    accessToken,
    payload.mineId,
    payload.latitude,
    payload.longitude,
    payload.observationType,
    payload.severity,
    payload.notes || "",
  ]);

export const getComplianceStatus = (accessToken, mineId) =>
  callBackend("get_compliance_status", [accessToken, mineId]);

// NOTE: actorUid is no longer sent -- the backend logs the audit entry
// using the uid derived from accessToken, which is more trustworthy than a
// client-supplied value anyway.
export const updateComplianceStatus = (accessToken, trackingId, newStatus, remarks = "") =>
  callBackend("update_compliance_status", [accessToken, trackingId, newStatus, remarks]);

export const chatWithAssistant = (accessToken, message, history = []) =>
  callBackend("chat_with_data_assistant", [accessToken, message, history]);

// Admin-only. Real gating is now the caller's OWN Supabase-verified role
// being 'admin' (checked server-side against user_profiles) -- adminKey is
// just an optional second factor on top, only enforced if ADMIN_SECRET_KEY
// is set in the backend's secrets. Pass "" if you haven't set one.
export const listPendingSignups = (accessToken, adminKey = "") =>
  callBackend("list_pending_signups", [accessToken, adminKey]);

export const approveUserRole = (accessToken, adminKey, payload) =>
  callBackend("approve_user_role", [
    accessToken,
    adminKey,
    payload.authUid,
    payload.email,
    payload.fullName || "",
    payload.role,
    payload.mineId || "",
    payload.subsidiaryId || "",
  ]);
