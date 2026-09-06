import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import { Card, Table, Button, Notice } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { listPendingSignups, approveUserRole } from "../../lib/api";
import { supabase } from "../../lib/supabase";

const ROLES = ["worker", "inspector", "mine_official", "contractor_manager",
  "corporate_admin", "regulator", "admin"];
const MINE_SCOPED = new Set(["worker", "inspector", "mine_official"]);
const defaultDraft = { role: "", mineId: "", subsidiaryId: "", fullName: "" };

function AdminContent() {
  const { getAccessToken } = useAuth();
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [mines, setMines] = useState([]);
  const [subs, setSubs] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [savingUid, setSavingUid] = useState(null);

  const load = async () => {
    try {
      const token = await getAccessToken();
      const res = await listPendingSignups(token, "");
      if (res?.error) setError(res.error);
      else { setPending(Array.isArray(res) ? res : []); setError(null); }
    } catch (e) { setError(String(e.message || e)); }
  };

  useEffect(() => {
    load();
    supabase.from("mines").select("mine_id, mine_name, state").order("mine_name").limit(500)
      .then(({ data }) => setMines(data || []));
    supabase.from("subsidiaries").select("subsidiary_id, subsidiary_code")
      .then(({ data }) => setSubs(data || []));
  }, []);

  const patch = (uid, p) =>
    setDrafts((prev) => ({ ...prev, [uid]: { ...defaultDraft, ...prev[uid], ...p } }));

  const approve = async (user) => {
    const d = drafts[user.auth_uid] || defaultDraft;
    if (!d.role) return setError("Choose a role before approving this account.");
    setSavingUid(user.auth_uid);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await approveUserRole(token, "", {
        authUid: user.auth_uid,
        email: user.email,
        fullName: d.fullName || user.display_name || "",
        role: d.role,
        mineId: MINE_SCOPED.has(d.role) ? d.mineId : "",
        subsidiaryId: d.subsidiaryId,
      });
      if (res?.error) setError(res.error); else load();
    } catch (e) { setError(String(e.message || e)); }
    finally { setSavingUid(null); }
  };

  return (
    <Layout title="User access" subtitle="Approve new accounts and assign roles">
      {error && <Notice tone="error">{error}</Notice>}

      <Card title="Waiting for a role">
        <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
          These people have signed up but can&apos;t reach a dashboard until you give
          them a role. Mine-based roles also need a mine.
        </p>
        <Table
          columns={[
            { key: "email", label: "Email" },
            { key: "fullName", label: "Name", width: 150,
              render: (u) => (
                <input placeholder={u.display_name || "Full name"}
                  value={(drafts[u.auth_uid] || defaultDraft).fullName}
                  onChange={(e) => patch(u.auth_uid, { fullName: e.target.value })} />
              ) },
            { key: "role", label: "Role", width: 170,
              render: (u) => (
                <select value={(drafts[u.auth_uid] || defaultDraft).role}
                  onChange={(e) => patch(u.auth_uid, { role: e.target.value })}>
                  <option value="">Choose a role</option>
                  {ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                </select>
              ) },
            { key: "mine", label: "Mine", width: 200,
              render: (u) => {
                const d = drafts[u.auth_uid] || defaultDraft;
                if (!MINE_SCOPED.has(d.role)) return <span style={{ color: "var(--ink-faint)" }}>Not needed</span>;
                return (
                  <select value={d.mineId} onChange={(e) => patch(u.auth_uid, { mineId: e.target.value })}>
                    <option value="">Choose a mine</option>
                    {mines.map((m) => (
                      <option key={m.mine_id} value={m.mine_id}>{m.mine_name} ({m.state})</option>
                    ))}
                  </select>
                );
              } },
            { key: "sub", label: "Subsidiary", width: 150,
              render: (u) => (
                <select value={(drafts[u.auth_uid] || defaultDraft).subsidiaryId}
                  onChange={(e) => patch(u.auth_uid, { subsidiaryId: e.target.value })}>
                  <option value="">None</option>
                  {subs.map((s) => (
                    <option key={s.subsidiary_id} value={s.subsidiary_id}>{s.subsidiary_code}</option>
                  ))}
                </select>
              ) },
            { key: "act", label: "", width: 110,
              render: (u) => (
                <Button disabled={savingUid === u.auth_uid} onClick={() => approve(u)}>
                  {savingUid === u.auth_uid ? "Saving" : "Approve"}
                </Button>
              ) },
          ]}
          rows={pending || []}
          empty="Everyone who has signed up already has a role."
        />
      </Card>

      <ChatPanel />
    </Layout>
  );
}

export default function AdminDashboard() {
  return (
    <RoleGuard allowedRoles={["admin"]}>
      <AdminContent />
    </RoleGuard>
  );
}
