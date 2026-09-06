import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import ChatPanel from "../../components/ChatPanel";
import { useAuth } from "../../lib/useAuth";
import { getComplianceStatus, updateComplianceStatus } from "../../lib/api";
import { supabase } from "../../lib/supabase";

const STATUS_OPTIONS = ["Completed", "Pending", "Overdue", "Not Applicable"];

function ManagerDashboardContent() {
  const { profile, logout, getAccessToken } = useAuth();
  const [compliance, setCompliance] = useState(null);
  const [grievances, setGrievances] = useState(null);
  const [contractors, setContractors] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const loadCompliance = async () => {
    if (!profile?.mine_id) return;
    const accessToken = await getAccessToken();
    getComplianceStatus(accessToken, profile.mine_id).then(setCompliance).catch(console.error);
  };

  useEffect(() => {
    if (!profile?.mine_id) return;

    loadCompliance();

    supabase.from("grievances").select("*")
      .eq("mine_id", profile.mine_id)
      .order("date_filed", { ascending: false })
      .limit(10)
      .then(({ data }) => setGrievances(data));

    supabase.from("contractors").select("*")
      .eq("mine_id", profile.mine_id)
      .then(({ data }) => setContractors(data));
  }, [profile]);

  const handleStatusChange = async (trackingId, newStatus) => {
    setSavingId(trackingId);
    try {
      const accessToken = await getAccessToken();
      await updateComplianceStatus(accessToken, trackingId, newStatus, "");
      loadCompliance(); // refetch so due_date/completed_date/status all stay in sync
    } catch (err) {
      console.error(err);
      alert("Couldn't save that update -- see console for details.");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>🏭 Mine Manager Dashboard</h1>
        <div>
          <span style={{ marginRight: 16 }}>{profile.full_name || profile.email} — {profile.role}</span>
          <button onClick={logout}>Log Out</button>
        </div>
      </div>

      <section style={{ marginTop: 24 }}>
        <h2>Compliance Checklist</h2>
        {compliance?.length ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr><th style={th}>Requirement</th><th style={th}>Category</th><th style={th}>Status</th><th style={th}>Due</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {compliance.map((c) => (
                <tr key={c.tracking_id}>
                  <td style={td}>{c.statutory_compliance_items?.requirement_summary}</td>
                  <td style={td}>{c.statutory_compliance_items?.category}</td>
                  <td style={td}>{c.status}</td>
                  <td style={td}>{c.due_date}</td>
                  <td style={td}>
                    <select
                      value={c.status}
                      disabled={savingId === c.tracking_id}
                      onChange={(e) => handleStatusChange(c.tracking_id, e.target.value)}
                    >
                      {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    {savingId === c.tracking_id && <span style={{ marginLeft: 8, fontSize: 12, color: "#666" }}>Saving...</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p style={{ color: "#666" }}>No compliance items loaded for this mine yet.</p>}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Recent Grievances</h2>
        {grievances?.length ? (
          <ul>{grievances.map((g) => <li key={g.grievance_id}>{g.date_filed} — {g.category} — {g.status}</li>)}</ul>
        ) : <p style={{ color: "#666" }}>No grievances filed at this mine.</p>}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Contractors at this Mine</h2>
        {contractors?.length ? (
          <ul>{contractors.map((c) => <li key={c.contractor_id}>{c.contractor_name} — {c.contract_type} — {c.status}</li>)}</ul>
        ) : <p style={{ color: "#666" }}>No contractors assigned.</p>}
      </section>
      <ChatPanel />
    </div>
  );
}

const th = { textAlign: "left", borderBottom: "2px solid #ddd", padding: 8 };
const td = { borderBottom: "1px solid #eee", padding: 8 };

export default function ManagerDashboard() {
  return (
    <RoleGuard allowedRoles={["mine_official"]}>
      <ManagerDashboardContent />
    </RoleGuard>
  );
}
