import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import { Card, Table, Badge, Field, Button, Notice } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";

const CATEGORIES = ["Wages/Payment Delay", "Safety Equipment Shortage", "Housing/Welfare",
  "Working Hours", "Harassment/Conduct", "Medical Facility", "Transport"];

function WorkerContent() {
  const { profile } = useAuth();
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [mine, setMine] = useState([]);

  const loadMine = async () => {
    if (!profile?.profile_id) return;
    const { data } = await supabase
      .from("grievances")
      .select("category, description, status, date_filed, resolution_note, resolved_at, priority")
      .eq("filed_by", profile.profile_id)
      .order("date_filed", { ascending: false })
      .limit(10);
    setMine(data || []);
  };

  useEffect(() => { loadMine(); }, [profile?.profile_id]);

  const file = async () => {
    setStatus(null);
    if (!description.trim()) return setStatus({ tone: "error", text: "Describe the issue before submitting." });
    if (!profile?.mine_id) return setStatus({ tone: "error", text: "No mine assigned to your account. Ask an administrator to set one." });

    setSaving(true);
    const { data, error } = await supabase.from("grievances").insert({
      mine_id: profile.mine_id,
      subsidiary_id: profile.subsidiary_id ?? null,
      filed_by: profile.profile_id,
      date_filed: new Date().toISOString().slice(0, 10),
      category,
      description,
      status: "In Progress",
      is_synthetic: false,
    }).select();
    setSaving(false);

    if (error) return setStatus({ tone: "error", text: `Could not file this grievance: ${error.message}` });
    if (!data?.length) return setStatus({ tone: "error", text: "The grievance was not saved. You may not have permission to file at this mine." });
    setStatus({ tone: "success", text: "Filed. Your mine official can see it now." });
    setDescription("");
    loadMine();
  };

  return (
    <Layout title="My mine" subtitle="">
      <Card title="Raise a grievance" style={{ maxWidth: 560 }}>
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        <Field label="What is this about?">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Describe the issue">
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Give as much detail as you can." />
        </Field>
        <Button onClick={file} disabled={saving}>{saving ? "Filing" : "File grievance"}</Button>
      </Card>

      <Card title="Grievances you have filed">
        <Table
          columns={[
            { key: "date_filed", label: "Filed", width: 110, nowrap: true },
            { key: "category", label: "Category", width: 190 },
            { key: "description", label: "Detail" },
            { key: "status", label: "Status", width: 120, render: (r) => <Badge>{r.status}</Badge> },
            // Showing the outcome, not just the status, is the point of
            // filing: a worker should be able to see what was actually
            // done about their complaint without asking anyone.
            { key: "resolution_note", label: "Outcome",
              render: (r) => r.resolution_note
                ? <span>{r.resolution_note}</span>
                : <span style={{ color: "var(--ink-faint)" }}>
                    {r.status === "Escalated" ? "Escalated for review" : "Being looked at"}
                  </span> },
          ]}
          rows={mine}
          severityOf={(r) => r.status}
          empty="You haven't filed anything yet. Use the form above to raise an issue."
        />
      </Card>

      <ChatPanel />
    </Layout>
  );
}

export default function WorkerDashboard() {
  return (
    <RoleGuard allowedRoles={["worker"]}>
      <WorkerContent />
    </RoleGuard>
  );
}
