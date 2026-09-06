import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import ChatPanel from "../../components/ChatPanel";
import { useAuth } from "../../lib/useAuth";
import { listPendingSignups, approveUserRole } from "../../lib/api";
import { supabase } from "../../lib/supabase";

// NOTE: the old NEXT_PUBLIC_ADMIN_API_KEY shared secret has been removed.
// Any NEXT_PUBLIC_ value is bundled into the browser JS and readable by
// anyone via dev tools, so it was never a real access control. Admin
// access is now enforced server-side: backend/app.py verifies the
// caller's Supabase token and checks their user_profiles.role == 'admin',
// and the RLS policies in supabase/schema.sql enforce the same rule at
// the database layer. The backend still accepts an optional admin_key
// argument (passed as "" here) for backward compatibility.

const ROLE_OPTIONS = [
  "worker", "inspector", "mine_official", "contractor_manager",
  "corporate_admin", "regulator", "admin",
];

// Roles that operate at one specific mine -- these show a mine picker.
// Corporate/regulator/admin/contractor_manager aren't tied to a single mine.
const MINE_SCOPED_ROLES = new Set(["worker", "inspector", "mine_official"]);

function AdminDashboardContent() {
  const { profile, logout, getAccessToken } = useAuth();
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [mines, setMines] = useState([]);
  const [subsidiaries, setSubsidiaries] = useState([]);
  const [drafts, setDrafts] = useState({}); // auth_uid -> { role, mineId, subsidiaryId, fullName }
  const [savingUid, setSavingUid] = useState(null);

  const loadPending = async () => {
    const accessToken = await getAccessToken();
    listPendingSignups(accessToken, "")
      .then((result) => {
        if (result?.error) setError(result.error);
        else { setPending(result); setError(null); }
      })
      .catch((err) => setError(String(err)));
  };

  useEffect(() => {
    loadPending();
    // Mines/subsidiaries pickers can be long lists -- keep this simple and
    // let the admin type a mine_id/subsidiary_id directly if the list is
    // too big to scan; the dropdowns are a convenience, not a requirement.
    supabase.from("mines").select("mine_id, mine_name, state").order("mine_name").then(({ data }) => setMines(data || []));
    supabase.from("subsidiaries").select("subsidiary_id, subsidiary_code").then(({ data }) => setSubsidiaries(data || []));
  }, []);

  const updateDraft = (uid, patch) =>
    setDrafts((prev) => ({ ...prev, [uid]: { ...defaultDraft, ...prev[uid], ...patch } }));

  const handleApprove = async (user) => {
    const draft = drafts[user.auth_uid] || defaultDraft;
    if (!draft.role) {
      alert("Pick a role first.");
      return;
    }
    setSavingUid(user.auth_uid);
    try {
      const accessToken = await getAccessToken();
      const result = await approveUserRole(accessToken, "", {
        authUid: user.auth_uid,
        email: user.email,
        fullName: draft.fullName || user.display_name || "",
        role: draft.role,
        mineId: MINE_SCOPED_ROLES.has(draft.role) ? draft.mineId : "",
        subsidiaryId: draft.subsidiaryId,
      });
      if (result?.error) {
        alert(result.error);
      } else {
        loadPending(); // approved user drops off the pending list
      }
    } catch (err) {
      alert(String(err));
    } finally {
      setSavingUid(null);
    }
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>🛠️ Admin Dashboard</h1>
        <div>
          <span style={{ marginRight: 16 }}>{profile?.full_name || profile?.email} — {profile?.role}</span>
          <button onClick={logout}>Log Out</button>
        </div>
      </div>

      <section style={{ marginTop: 24 }}>
        <h2>Pending Signups</h2>
        <p style={{ color: "#666", fontSize: 14 }}>
          Accounts that have signed up but have no <code>user_profiles</code> row yet --
          they're stuck on the "Account Pending Setup" screen until you assign them a role here.
        </p>

        {error && <p style={{ color: "#b00" }}>{error}</p>}

        {pending?.length ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Email</th><th style={th}>Name</th><th style={th}>Role</th>
                <th style={th}>Mine (if role needs one)</th><th style={th}>Subsidiary (optional)</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((user) => {
                const draft = drafts[user.auth_uid] || defaultDraft;
                return (
                  <tr key={user.auth_uid}>
                    <td style={td}>{user.email}</td>
                    <td style={td}>
                      <input
                        placeholder={user.display_name || "Full name"}
                        value={draft.fullName}
                        onChange={(e) => updateDraft(user.auth_uid, { fullName: e.target.value })}
                        style={{ width: 120 }}
                      />
                    </td>
                    <td style={td}>
                      <select value={draft.role} onChange={(e) => updateDraft(user.auth_uid, { role: e.target.value })}>
                        <option value="">-- pick --</option>
                        {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                    <td style={td}>
                      {MINE_SCOPED_ROLES.has(draft.role) && (
                        <select value={draft.mineId} onChange={(e) => updateDraft(user.auth_uid, { mineId: e.target.value })}>
                          <option value="">-- pick a mine --</option>
                          {mines.map((m) => (
                            <option key={m.mine_id} value={m.mine_id}>{m.mine_name} ({m.state})</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td style={td}>
                      <select value={draft.subsidiaryId} onChange={(e) => updateDraft(user.auth_uid, { subsidiaryId: e.target.value })}>
                        <option value="">-- none --</option>
                        {subsidiaries.map((s) => (
                          <option key={s.subsidiary_id} value={s.subsidiary_id}>{s.subsidiary_code}</option>
                        ))}
                      </select>
                    </td>
                    <td style={td}>
                      <button disabled={savingUid === user.auth_uid} onClick={() => handleApprove(user)}>
                        {savingUid === user.auth_uid ? "Saving..." : "Approve"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : !error && <p style={{ color: "#666" }}>No pending signups right now.</p>}
      </section>
      <ChatPanel />
    </div>
  );
}

const defaultDraft = { role: "", mineId: "", subsidiaryId: "", fullName: "" };
const th = { textAlign: "left", borderBottom: "2px solid #ddd", padding: 8 };
const td = { borderBottom: "1px solid #eee", padding: 8 };

export default function AdminDashboard() {
  return (
    <RoleGuard allowedRoles={["admin"]}>
      <AdminDashboardContent />
    </RoleGuard>
  );
}
