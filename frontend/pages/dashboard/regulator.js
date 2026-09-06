import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import { useAuth } from "../../lib/useAuth";
import { getDashboardSummary } from "../../lib/api";
import { supabase } from "../../lib/supabase";

function RegulatorDashboardContent() {
  const { profile, logout, getAccessToken } = useAuth();
  const [summary, setSummary] = useState(null);
  const [auditLog, setAuditLog] = useState(null);

  useEffect(() => {
    (async () => {
      const accessToken = await getAccessToken();
      getDashboardSummary(accessToken, "All").then(setSummary).catch(console.error);
    })();
    supabase.from("audit_log").select("*").order("timestamp", { ascending: false }).limit(20)
      .then(({ data }) => setAuditLog(data));
  }, []);

  return (
    <div style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>⚖️ Regulator Oversight</h1>
        <button onClick={logout}>Log Out</button>
      </div>
      <p>{profile.full_name || profile.email} — Read-only regulatory access</p>

      <section style={{ marginTop: 24 }}>
        <h2>National Snapshot</h2>
        <p>Total mines: {summary?.total_mines ?? "—"} · Fatal accidents: {summary?.fatal_accidents_recorded ?? "—"} · Overdue compliance: {summary?.overdue_compliance_items ?? "—"}</p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Recent Audit Log</h2>
        {auditLog?.length ? (
          <ul>{auditLog.map((a) => <li key={a.log_id}>{a.timestamp} — {a.action} on {a.table_affected}</li>)}</ul>
        ) : <p style={{ color: "#666" }}>No audit entries yet.</p>}
      </section>
    </div>
  );
}

export default function RegulatorDashboard() {
  return (
    <RoleGuard allowedRoles={["regulator"]}>
      <RegulatorDashboardContent />
    </RoleGuard>
  );
}
