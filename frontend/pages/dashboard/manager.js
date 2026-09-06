import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import { Card, StatStrip, Table, Badge, Notice } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { getComplianceStatus, updateComplianceStatus } from "../../lib/api";
import { supabase } from "../../lib/supabase";

const STATUS_OPTIONS = ["Completed", "Pending", "Overdue", "Not Applicable"];

function ManagerContent() {
  const { profile, getAccessToken } = useAuth();
  const [compliance, setCompliance] = useState(null);
  const [grievances, setGrievances] = useState(null);
  const [contractors, setContractors] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState(null);

  const loadCompliance = async () => {
    if (!profile?.mine_id) return;
    const token = await getAccessToken();
    const c = await getComplianceStatus(token, profile.mine_id);
    if (c?.error) setError(c.error);
    else setCompliance(Array.isArray(c) ? c : []);
  };

  useEffect(() => {
    if (!profile?.mine_id) return;
    loadCompliance();
    supabase.from("grievances").select("*").eq("mine_id", profile.mine_id)
      .order("date_filed", { ascending: false }).limit(10)
      .then(({ data }) => setGrievances(data || []));
    supabase.from("contractors").select("*").eq("mine_id", profile.mine_id)
      .then(({ data }) => setContractors(data || []));
  }, [profile?.mine_id]);

  const handleStatusChange = async (trackingId, newStatus) => {
    setSavingId(trackingId);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await updateComplianceStatus(token, trackingId, newStatus, "");
      if (res?.error) setError(res.error);
      else await loadCompliance();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSavingId(null);
    }
  };

  const overdue = (compliance || []).filter((c) => c.status === "Overdue").length;
  const pending = (compliance || []).filter((c) => c.status === "Pending").length;
  const openGrievances = (grievances || []).filter((g) => g.status !== "Resolved").length;

  return (
    <Layout title="Mine operations" subtitle="">
      {error && <Notice tone="error">{error}</Notice>}

      <StatStrip
        items={[
          { label: "Overdue obligations", value: overdue, tone: overdue ? "critical" : null },
          { label: "Pending obligations", value: pending, tone: pending ? "medium" : null },
          { label: "Open grievances", value: openGrievances, tone: openGrievances ? "high" : null },
        ]}
      />

      <Card title="Statutory compliance">
        <Table
          columns={[
            { key: "req", label: "Requirement",
              render: (r) => r.statutory_compliance_items?.requirement_summary || "—" },
            { key: "cat", label: "Area", width: 110,
              render: (r) => r.statutory_compliance_items?.category || "—" },
            { key: "due", label: "Due", width: 110, nowrap: true, render: (r) => r.due_date || "—" },
            { key: "status", label: "Status", width: 110, render: (r) => <Badge>{r.status}</Badge> },
            { key: "set", label: "Change to", width: 150,
              render: (r) => (
                <select
                  value={r.status || "Pending"}
                  disabled={savingId === r.tracking_id}
                  onChange={(e) => handleStatusChange(r.tracking_id, e.target.value)}
                >
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) },
          ]}
          rows={compliance || []}
          severityOf={(r) => r.status}
          empty="No compliance items recorded for this mine."
        />
      </Card>

      <Card title="Grievances">
        <Table
          columns={[
            { key: "category", label: "Category", width: 180 },
            { key: "description", label: "Detail" },
            { key: "date_filed", label: "Filed", width: 110, nowrap: true },
            { key: "status", label: "Status", width: 120, render: (r) => <Badge>{r.status}</Badge> },
          ]}
          rows={grievances || []}
          severityOf={(r) => r.status}
          empty="No grievances filed at this mine."
        />
      </Card>

      <Card title="Contractors on site">
        <Table
          columns={[
            { key: "contractor_name", label: "Contractor" },
            { key: "contract_type", label: "Scope" },
            { key: "contract_end", label: "Contract ends", width: 130, nowrap: true },
            { key: "status", label: "Status", width: 120, render: (r) => <Badge>{r.status}</Badge> },
          ]}
          rows={contractors || []}
          severityOf={(r) => r.status}
          empty="No contractors assigned to this mine."
        />
      </Card>

      <ChatPanel />
    </Layout>
  );
}

export default function ManagerDashboard() {
  return (
    <RoleGuard allowedRoles={["mine_official"]}>
      <ManagerContent />
    </RoleGuard>
  );
}
