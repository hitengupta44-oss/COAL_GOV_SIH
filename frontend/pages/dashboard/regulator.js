import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import MineMap from "../../components/MineMap";
import ReportPanel from "../../components/ReportPanel";
import GrievanceOverview from "../../components/GrievanceOverview";
import AlertsPanel from "../../components/AlertsPanel";
import Link from "next/link";
import { Card, StatStrip, Table, Badge, Notice } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { getDashboardSummary, getHighRiskMines } from "../../lib/api";

function RegulatorContent() {
  const { getAccessToken } = useAuth();
  const [summary, setSummary] = useState(null);
  const [risk, setRisk] = useState(null);
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
      <StatStrip
        items={[
          { label: "Corrective actions past deadline", value: summary?.overdue_corrective_actions ?? "—", tone: "high" },
          { label: "Incidents, last 30 days", value: summary?.incidents_last_30_days ?? "—" },
          { label: "DGMS accident notices overdue", value: summary?.dgms_notices_overdue ?? "—",
            tone: summary?.dgms_notices_overdue ? "critical" : null },
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

      <Card title="Records and proof">
        <p style={{ fontSize: 14, color: "var(--ink-soft)", margin: 0 }}>
          The <Link href="/dashboard/audit">audit trail</Link> lists every change with who made it, and can prove
          the record has not been altered. <Link href="/dashboard/returns">Statutory returns</Link> appear once
          corporate management has approved them, each with a content fingerprint.{" "}
          <Link href="/dashboard/actions">Corrective actions</Link> and <Link href="/dashboard/incidents">incidents</Link>{" "}
          are visible across every mine.
        </p>
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
