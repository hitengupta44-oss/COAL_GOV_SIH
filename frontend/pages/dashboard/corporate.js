import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import { useAuth } from "../../lib/useAuth";
import { getDashboardSummary, getHighRiskMines } from "../../lib/api";

function CorporateDashboardContent() {
  const { profile, logout, getAccessToken } = useAuth();
  const [summary, setSummary] = useState(null);
  const [riskMines, setRiskMines] = useState(null);
  const [error, setError] = useState(null);

  // Errors are surfaced on the page rather than only console.error'd.
  // Silently swallowing them is what made this hard to debug: a failing
  // call just left the KPI cards showing "—", which looks identical to
  // "the data is genuinely zero" and gives no clue that anything broke.
  // Note the backend returns errors as a normal 200 response with an
  // {error: "..."} body, so a rejected promise is not the only failure
  // mode -- the resolved value has to be checked too.
  useEffect(() => {
    (async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) {
          setError("No access token -- your session may have expired. Try logging in again.");
          return;
        }
        const s = await getDashboardSummary(accessToken, "All");
        if (s && s.error) setError(`Backend: ${s.error}`);
        else setSummary(s);

        const r = await getHighRiskMines(accessToken, 10);
        if (r && r.error) setError((e) => e || `Backend: ${r.error}`);
        else setRiskMines(r);
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
  }, []);

  return (
    <div style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>🏢 Corporate Dashboard</h1>
        <button onClick={logout}>Log Out</button>
      </div>
      <p>{profile?.full_name || profile?.email} — Corporate Management</p>
      {error && (
        <p style={{ color: "#b00", background: "#fee", padding: 12, borderRadius: 6 }}>
          {error}
        </p>
      )}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginTop: 24 }}>
        <StatCard label="Total Mines" value={summary?.total_mines ?? "—"} />
        <StatCard label="Fatal Accidents Recorded" value={summary?.fatal_accidents_recorded ?? "—"} />
        <StatCard label="Overdue Compliance Items" value={summary?.overdue_compliance_items ?? "—"} />
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>High-Risk Mines (Cross-Subsidiary)</h2>
        {Array.isArray(riskMines) && riskMines.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={th}>Mine</th>
                <th style={th}>State</th>
                <th style={th}>Flag</th>
                <th style={th}>Risk</th>
                <th style={th}>Why</th>
              </tr>
            </thead>
            <tbody>
              {riskMines.map((m, i) => (
                <tr key={i}>
                  {/* falls back to the id only when the name lookup missed */}
                  <td style={td}>{m.mine_name || m.mine_id}</td>
                  <td style={td}>{m.state || "—"}</td>
                  <td style={td}>{m.flag_type}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{m.risk_score}</td>
                  <td style={td}>{m.explanation || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p style={{ color: "#666" }}>No risk flags generated yet.</p>}
      </section>
    </div>
  );
}

const th = { textAlign: "left", borderBottom: "2px solid #ddd", padding: 8 };
const td = { borderBottom: "1px solid #eee", padding: 8, verticalAlign: "top" };

function StatCard({ label, value }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 20 }}>
      <div style={{ fontSize: 13, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

export default function CorporateDashboard() {
  return (
    <RoleGuard allowedRoles={["corporate_admin"]}>
      <CorporateDashboardContent />
    </RoleGuard>
  );
}
