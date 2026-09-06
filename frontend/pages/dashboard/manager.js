import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import AlertsPanel from "../../components/AlertsPanel";
import { Card, StatStrip, Table, Badge, Button, Notice } from "../../components/ui";
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
  const [resolving, setResolving] = useState(null);   // grievance being closed
  const [note, setNote] = useState("");

  const loadCompliance = async () => {
    if (!profile?.mine_id) return;
    const token = await getAccessToken();
    const c = await getComplianceStatus(token, profile.mine_id);
    if (c?.error) setError(c.error);
    else setCompliance(Array.isArray(c) ? c : []);
  };

  // Read from the view rather than the table: it computes is_overdue from
  // the deadline, so the dashboard, the alerts and the assistant all agree
  // on what "overdue" means instead of each deriving it separately.
  const loadGrievances = async () => {
    if (!profile?.mine_id) return;
    const { data } = await supabase
      .from("grievance_status_view")
      .select("*")
      .eq("mine_id", profile.mine_id)
      .order("date_filed", { ascending: false })
      .limit(25);
    setGrievances(data || []);
  };

  // Closing a grievance requires a note. A status flag on its own records
  // that someone clicked something; the note records what was actually
  // done, which is the part a regulator or the worker can hold anyone to.
  const resolve = async (g) => {
    if (!note.trim()) return setError("Write what was done before closing this grievance.");
    setSavingId(g.grievance_id);
    setError(null);
    const { data, error: err } = await supabase
      .from("grievances")
      .update({
        status: "Resolved",
        resolution_note: note,
        resolved_by: profile.profile_id,
        resolved_at: new Date().toISOString(),
      })
      .eq("grievance_id", g.grievance_id)
      .select();
    setSavingId(null);
    if (err) return setError(`Could not close this grievance: ${err.message}`);
    if (!data?.length) return setError("The change was not saved. You may not have permission to close this grievance.");
    setResolving(null); setNote(""); loadGrievances();
  };

  const escalate = async (g) => {
    setSavingId(g.grievance_id);
    const { error: err } = await supabase
      .from("grievances")
      .update({ status: "Escalated", escalated: true, escalated_at: new Date().toISOString() })
      .eq("grievance_id", g.grievance_id);
    setSavingId(null);
    if (err) setError(`Could not escalate: ${err.message}`);
    else loadGrievances();
  };

  useEffect(() => {
    if (!profile?.mine_id) return;
    loadCompliance();
    loadGrievances();
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
  const overdueGrievances = (grievances || []).filter((g) => g.is_overdue).length;

  return (
    <Layout title="Mine operations" subtitle="">
      {error && <Notice tone="error">{error}</Notice>}

      <StatStrip
        items={[
          { label: "Overdue obligations", value: overdue, tone: overdue ? "critical" : null },
          { label: "Pending obligations", value: pending, tone: pending ? "medium" : null },
          { label: "Open grievances", value: openGrievances, tone: openGrievances ? "high" : null,
            note: overdueGrievances ? `${overdueGrievances} past deadline` : undefined },
        ]}
      />

      <AlertsPanel />

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
        <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
          Safety and conduct cases carry a 7-day response deadline; others 14 days.
          Closing a case requires a note describing what was done.
        </p>
        {resolving && (
          <div style={{ background: "var(--primary-wash)", borderLeft: "3px solid var(--primary)", padding: 14, marginBottom: 14, borderRadius: 3 }}>
            <div style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 6 }}>
              Closing: {resolving.category} — {resolving.description}
            </div>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="What was done to resolve this?" style={{ marginBottom: 8 }} />
            <Button onClick={() => resolve(resolving)} disabled={savingId === resolving.grievance_id}>
              {savingId === resolving.grievance_id ? "Saving" : "Close grievance"}
            </Button>
            <Button variant="quiet" onClick={() => { setResolving(null); setNote(""); }}
              style={{ marginLeft: 12 }}>Cancel</Button>
          </div>
        )}
        <Table
          columns={[
            { key: "category", label: "Category", width: 170 },
            { key: "description", label: "Detail" },
            { key: "priority", label: "Priority", width: 90,
              render: (r) => r.priority ? <Badge>{r.priority}</Badge> : "—" },
            { key: "due_by", label: "Due", width: 110, nowrap: true,
              render: (r) => r.is_overdue
                ? <span style={{ color: "var(--sev-critical)" }}>{Math.abs(r.days_remaining)} days over</span>
                : (r.due_by || "—") },
            { key: "status", label: "Status", width: 110, render: (r) => <Badge>{r.status}</Badge> },
            { key: "act", label: "", width: 170,
              render: (r) => r.status === "Resolved"
                ? <span style={{ color: "var(--ink-faint)", fontSize: 13 }}>
                    {r.days_to_resolve != null ? `Closed in ${r.days_to_resolve} days` : "Closed"}
                  </span>
                : (
                  <>
                    <Button variant="secondary" onClick={() => { setResolving(r); setNote(""); }}>Close</Button>
                    {!r.escalated && (
                      <Button variant="quiet" onClick={() => escalate(r)}
                        style={{ marginLeft: 8 }}>Escalate</Button>
                    )}
                  </>
                ) },
          ]}
          rows={grievances || []}
          severityOf={(r) => r.is_overdue ? "Critical" : r.status}
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
