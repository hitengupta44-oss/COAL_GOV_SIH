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

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL; // e.g. https://yourname-coal-backend.hf.space

async function callBackend(fnName, args = []) {
  const res = await fetch(`${BACKEND_URL}/api/${fnName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: args }),
  });
  if (!res.ok) throw new Error(`Backend call failed: ${fnName} (${res.status})`);
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
