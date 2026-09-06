import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import { Card, StatStrip, Table, Notice, Empty } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { getDashboardSummary, getHighRiskMines } from "../../lib/api";

function CorporateContent() {
  const { getAccessToken } = useAuth();
  const [summary, setSummary] = useState(null);
  const [riskMines, setRiskMines] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return setError("Your session has expired. Log in again to continue.");
        const s = await getDashboardSummary(token, "All");
        if (s?.error) setError(s.error); else setSummary(s);
        const r = await getHighRiskMines(token, 12);
        if (!r?.error) setRiskMines(Array.isArray(r) ? r : []);
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
  }, []);

  const scoreTone = (s) => (s >= 0.9 ? "Critical" : s >= 0.7 ? "High" : s >= 0.4 ? "Medium" : "Low");

  return (
    <Layout title="Overview" subtitle="All subsidiaries">
      {error && <Notice tone="error">{error}</Notice>}

      <StatStrip
        items={[
          { label: "Mines", value: summary?.total_mines ?? "—" },
          { label: "Fatal accidents recorded", value: summary?.fatal_accidents_recorded ?? "—", tone: "critical" },
          { label: "Overdue compliance items", value: summary?.overdue_compliance_items ?? "—", tone: "high" },
        ]}
      />

      <Card title="Mines flagged for review">
        {riskMines === null ? (
          <Empty>Loading risk analysis.</Empty>
        ) : (
          <Table
            columns={[
              { key: "mine_name", label: "Mine", render: (r) => <strong>{r.mine_name || r.mine_id}</strong> },
              { key: "state", label: "State", render: (r) => r.state || "—" },
              { key: "flag_type", label: "Finding" },
              { key: "risk_score", label: "Score", align: "right", width: 70 },
              { key: "explanation", label: "Basis", render: (r) => (
                  <span style={{ color: "var(--ink-soft)" }}>{r.explanation || "—"}</span>
                ) },
            ]}
            rows={riskMines}
            severityOf={(r) => scoreTone(r.risk_score)}
            empty="No mines flagged. Run the risk analysis job to populate this."
          />
        )}
      </Card>

      <ChatPanel />
    </Layout>
  );
}

export default function CorporateDashboard() {
  return (
    <RoleGuard allowedRoles={["corporate_admin"]}>
      <CorporateContent />
    </RoleGuard>
  );
}
