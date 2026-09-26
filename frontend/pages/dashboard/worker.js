import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import MineMap from "../../components/MineMap";
import { Card, Table, Badge, Field, Button, Notice } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";
import { enqueue } from "../../lib/offlineQueue";
import { useT } from "../../lib/i18n";

const CATEGORIES = ["Wages/Payment Delay", "Safety Equipment Shortage", "Housing/Welfare",
  "Working Hours", "Harassment/Conduct", "Medical Facility", "Transport"];

function WorkerContent() {
  const { profile } = useAuth();
  const { t } = useT();
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
      .limit(200);
    setMine(data || []);
  };

  useEffect(() => { loadMine(); }, [profile?.profile_id]);

  const file = async () => {
    setStatus(null);
    if (!description.trim()) return setStatus({ tone: "error", text: t("worker.needText") });
    if (!profile?.mine_id) return setStatus({ tone: "error", text: t("noMine") });

    setSaving(true);
    const row = {
      mine_id: profile.mine_id,
      subsidiary_id: profile.subsidiary_id ?? null,
      filed_by: profile.profile_id,
      date_filed: new Date().toISOString().slice(0, 10),
      category,
      description,
      status: "In Progress",
      is_synthetic: false,
    };

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      try {
        await enqueue("grievance", row, profile?.profile_id);
        setSaving(false);
        setStatus({ tone: "info", text: t("savedOffline") });
        setDescription("");
      } catch (e) {
        setSaving(false);
        setStatus({ tone: "error", text: `Could not save offline: ${e.message || e}` });
      }
      return;
    }

    const { data, error } = await supabase.from("grievances").insert(row).select();
    setSaving(false);

    if (error) return setStatus({ tone: "error", text: `Could not file this grievance: ${error.message}` });
    if (!data?.length) return setStatus({ tone: "error", text: "The grievance was not saved. You may not have permission to file at this mine." });
    setStatus({ tone: "success", text: t("worker.filed") });
    setDescription("");
    loadMine();
  };

  return (
    <Layout title={t("worker.title")} subtitle="">
      <Card title={t("worker.raise")} style={{ maxWidth: 560 }}>
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        <Field label={t("worker.about")}>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`cat.${c}`)}</option>)}
          </select>
        </Field>
        <Field label={t("worker.describe")}>
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder={t("worker.describeHint")} />
        </Field>
        <Button onClick={file} disabled={saving}>{saving ? t("worker.filing") : t("worker.file")}</Button>
      </Card>

      <Card title={t("worker.yours")}>
        <Table
          columns={[
            { key: "date_filed", label: t("worker.filedOn"), width: 110, nowrap: true },
            { key: "category", label: t("worker.category"), width: 190, render: (r) => t(`cat.${r.category}`) },
            { key: "description", label: t("worker.detail") },
            { key: "status", label: t("status"), width: 120, render: (r) => <Badge>{r.status}</Badge> },
            // Showing the outcome, not just the status, is the point of
            // filing: a worker should be able to see what was actually
            // done about their complaint without asking anyone.
            { key: "resolution_note", label: t("worker.outcome"),
              render: (r) => r.resolution_note
                ? <span>{r.resolution_note}</span>
                : <span style={{ color: "var(--ink-faint)" }}>
                    {r.status === "Escalated" ? t("worker.escalated") : t("worker.beingLooked")}
                  </span> },
          ]}
          rows={mine}
          countLabel="grievances"
          severityOf={(r) => r.status}
          empty={t("worker.none")}
        />
      </Card>

      <MineMap />

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
