import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import MineMap from "../../components/MineMap";
import ReportPanel from "../../components/ReportPanel";
import GrievanceOverview from "../../components/GrievanceOverview";
import AlertsPanel from "../../components/AlertsPanel";
import PredictionsPanel from "../../components/PredictionsPanel";
import ContractorApprovals from "../../components/ContractorApprovals";
import Link from "next/link";
import { supabase } from "../../lib/supabase";
import { Card, StatStrip, Table, Badge, Notice, Empty } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { getDashboardSummary, getHighRiskMines } from "../../lib/api";

function CorporateContent() {
  const { getAccessToken } = useAuth();
  const [summary, setSummary] = useState(null);
  const [riskMines, setRiskMines] = useState(null);
  const [error, setError] = useState(null);
  const [subs, setSubs] = useState([]);
  const [sub, setSub] = useState("All");

  useEffect(() => {
    supabase.from("subsidiaries").select("subsidiary_id, subsidiary_code, subsidiary_name").order("subsidiary_code")
      .then(({ data }) => setSubs(data || []));
  }, []);

  // Every figure on the page follows the subsidiary choice: the KPIs are
  // filtered by the backend, and the flag list by the mines that belong to
  // the subsidiary.
  useEffect(() => {
    (async () => {
      try {
        setError(null); setSummary(null); setRiskMines(null);
        const token = await getAccessToken();
        if (!token) return setError("Your session has expired. Log in again to continue.");
        const s = await getDashboardSummary(token, sub);
        if (s?.error) setError(s.error); else setSummary(s);

        let ids = null;
        if (sub !== "All") {
          const sid = subs.find((x) => x.subsidiary_code === sub)?.subsidiary_id;
          const { data } = await supabase.from("mines").select("mine_id").eq("subsidiary_id", sid);
          ids = new Set((data || []).map((m) => m.mine_id));
        }
        const r = await getHighRiskMines(token, ids ? 100 : 12);
        if (!r?.error) {
          const list = Array.isArray(r) ? r : [];
          setRiskMines((ids ? list.filter((f) => ids.has(f.mine_id)) : list).slice(0, 12));
        }
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
  }, [sub, subs.length]);

  const subId = sub === "All" ? null : subs.find((x) => x.subsidiary_code === sub)?.subsidiary_id;

  const scoreTone = (s) => (s >= 0.9 ? "Critical" : s >= 0.7 ? "High" : s >= 0.4 ? "Medium" : "Low");

  return (
    <Layout title="Overview" subtitle={sub === "All" ? "All subsidiaries" : subs.find((x) => x.subsidiary_code === sub)?.subsidiary_name}>
      <div style={{ marginBottom: 20, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 14, color: "var(--ink-soft)" }} htmlFor="sub">Subsidiary</label>
        <select id="sub" value={sub} onChange={(e) => setSub(e.target.value)} style={{ width: 260 }}>
          <option value="All">All subsidiaries</option>
          {subs.map((x) => <option key={x.subsidiary_code} value={x.subsidiary_code}>{x.subsidiary_code} · {x.subsidiary_name}</option>)}
        </select>
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      <StatStrip
        items={[
          { label: "Mines", value: summary?.total_mines ?? "—" },
          { label: "Fatal accidents recorded", value: summary?.fatal_accidents_recorded ?? "—", tone: "critical" },
          { label: "Overdue compliance items", value: summary?.overdue_compliance_items ?? "—", tone: "high" },
        ]}
      />
      <StatStrip
        items={[
          { label: "Corrective actions past deadline", value: summary?.overdue_corrective_actions ?? "—", tone: "high" },
          { label: "Fixes awaiting verification", value: summary?.awaiting_verification ?? "—" },
          { label: "Incidents, last 30 days", value: summary?.incidents_last_30_days ?? "—",
            note: summary?.dgms_notices_overdue ? `${summary.dgms_notices_overdue} DGMS notice(s) overdue` : undefined,
            tone: summary?.dgms_notices_overdue ? "critical" : null },
          { label: "Returns awaiting your approval", value: summary?.returns_awaiting_approval ?? "—",
            tone: summary?.returns_awaiting_approval ? "medium" : null,
            note: summary?.returns_awaiting_approval ? <Link href="/dashboard/returns">Review returns</Link> : undefined },
        ]}
      />

      <AlertsPanel />

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
            // The mine's answer sits beside the finding. A flag with no
            // visible response looks identical to one the site has already
            // fixed, and oversight needs to tell those apart.
            { key: "response_status", label: "Mine's response", width: 140,
              render: (r) => r.response_status && r.response_status !== "Open"
                ? <Badge>{r.response_status === "Addressed" ? "Low" : "Medium"}</Badge>
                : <span style={{ color: "var(--ink-faint)" }}>No response</span> },
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

      <PredictionsPanel wide subsidiaryId={subId} />

      <ContractorApprovals wide />

      <GrievanceOverview mode="corporate" />

      <ReportPanel />

      <MineMap />

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
