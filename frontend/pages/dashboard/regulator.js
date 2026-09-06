import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import MineMap from "../../components/MineMap";
import ReportPanel from "../../components/ReportPanel";
import GrievanceOverview from "../../components/GrievanceOverview";
import AlertsPanel from "../../components/AlertsPanel";
import { Card, StatStrip, Table, Badge, Notice } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { getDashboardSummary, getHighRiskMines } from "../../lib/api";
import { supabase } from "../../lib/supabase";

function RegulatorContent() {
  const { getAccessToken } = useAuth();
  const [summary, setSummary] = useState(null);
  const [risk, setRisk] = useState(null);
  const [auditLog, setAuditLog] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getAccessToken();
        const s = await getDashboardSummary(token, "All");
        if (s?.error) setError(s.error); else setSummary(s);
        const r = await getHighRiskMines(token, 10);
        if (!r?.error) setRisk(Array.isArray(r) ? r : []);
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
    supabase
      .from("audit_log")
      .select("action, table_affected, details, timestamp")
      .order("timestamp", { ascending: false })
      .limit(300)
      .then(({ data }) => setAuditLog(data || []));
  }, []);

  const scoreTone = (s) => (s >= 0.9 ? "Critical" : s >= 0.7 ? "High" : s >= 0.4 ? "Medium" : "Low");

  return (
    <Layout title="Oversight" subtitle="Read-only access across all mines">
      {error && <Notice tone="error">{error}</Notice>}

      <StatStrip
        items={[
          { label: "Mines on record", value: summary?.total_mines ?? "—" },
          { label: "Fatal accidents recorded", value: summary?.fatal_accidents_recorded ?? "—", tone: "critical" },
          { label: "Overdue compliance items", value: summary?.overdue_compliance_items ?? "—", tone: "high" },
        ]}
      />

      <AlertsPanel />

      <Card title="Mines flagged for review">
        <Table
          columns={[
            { key: "mine_name", label: "Mine", render: (r) => <strong>{r.mine_name || r.mine_id}</strong> },
            { key: "state", label: "State", render: (r) => r.state || "—" },
            { key: "flag_type", label: "Finding" },
            { key: "risk_score", label: "Score", align: "right", width: 70 },
            // The mine's answer sits beside the finding. A flag with no
            // visible response looks identical to one the site has already
            // fixed, and oversight needs to tell those apart.
            { key: "response_status", label: "Mine's response", width: 140,
              render: (r) => r.response_status && r.response_status !== "Open"
                ? <Badge>{r.response_status === "Addressed" ? "Low" : "Medium"}</Badge>
                : <span style={{ color: "var(--ink-faint)" }}>No response</span> },
          ]}
          rows={risk || []}
          severityOf={(r) => scoreTone(r.risk_score)}
          empty="No mines flagged."
        />
      </Card>

      <Card title="Compliance activity trail">
        <Table
          columns={[
            { key: "timestamp", label: "When", width: 170, nowrap: true,
              render: (r) => (r.timestamp ? new Date(r.timestamp).toLocaleString() : "—") },
            { key: "action", label: "Action" },
            { key: "table_affected", label: "Record" },
            { key: "details", label: "Detail",
              render: (r) => (
                <span style={{ color: "var(--ink-soft)" }}>
                  {r.details ? JSON.stringify(r.details) : "—"}
                </span>
              ) },
          ]}
          rows={auditLog || []}
          countLabel="entries"
          empty="No changes recorded yet. Entries appear here when a mine official updates a compliance item."
        />
      </Card>

      <GrievanceOverview mode="regulator" />

      <ReportPanel />

      <MineMap />

      <ChatPanel />
    </Layout>
  );
}

export default function RegulatorDashboard() {
  return (
    <RoleGuard allowedRoles={["regulator"]}>
      <RegulatorContent />
    </RoleGuard>
  );
}
