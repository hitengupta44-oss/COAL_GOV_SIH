import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import OcrCapture from "../../components/OcrCapture";
import MineMap from "../../components/MineMap";
import { Card, Table, Badge, Field, Button, Notice } from "../../components/ui";
import { PhotoInput, EvidenceLink, GeoBadge } from "../../components/Evidence";
import { useT } from "../../lib/i18n";
import { getPosition, isOnline, formatDistance } from "../../lib/geo";
import { uploadEvidence } from "../../lib/evidence";
import { useAuth } from "../../lib/useAuth";
import { logFieldInspection } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { enqueue } from "../../lib/offlineQueue";

const OBSERVATIONS = ["Safety Equipment Check", "Ventilation Inspection", "Slope Stability",
  "Electrical Safety", "Housekeeping", "Water Accumulation", "PPE Compliance"];

function InspectorContent() {
  const { profile, getAccessToken } = useAuth();
  const { t } = useT();
  const [photo, setPhoto] = useState(null);
  const [obsType, setObsType] = useState(OBSERVATIONS[0]);
  const [severity, setSeverity] = useState("Low");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [recent, setRecent] = useState([]);

  const loadRecent = async () => {
    if (!profile?.mine_id) return;
    const { data } = await supabase
      .from("geo_inspections")
      .select("observation_type, severity, notes, timestamp, latitude, longitude, photo_url, "
            + "within_geofence, distance_from_mine_m, corrective_action_status")
      .eq("mine_id", profile.mine_id)
      .order("timestamp", { ascending: false })
      .limit(300);
    setRecent(data || []);
  };

  useEffect(() => { loadRecent(); }, [profile?.mine_id]);

  // Only fields the reader was confident about are overwritten. A wrong
  // guess silently replacing a choice the inspector already made would be
  // worse than leaving it alone -- the text is a draft, not an authority.
  const applyExtract = ({ notes, observationType, severity }) => {
    if (notes) setNotes((prev) => (prev ? prev + "\n\n" + notes : notes));
    if (observationType && OBSERVATIONS.includes(observationType)) setObsType(observationType);
    if (severity) setSeverity(severity);
  };

  // Location is captured rather than typed: the point of a geo-tagged
  // inspection is that the coordinates come from the device at the site,
  // not from whatever the inspector types afterwards. The capture time
  // travels with the record, so one sent hours later from a queue still
  // carries the time it was actually made.
  const submit = async () => {
    if (!profile?.mine_id) return setStatus({ tone: "error", text: t("noMine") });
    setSubmitting(true);
    setStatus({ tone: "info", text: t("location.getting") });

    let pos;
    try {
      pos = await getPosition();
    } catch (e) {
      setSubmitting(false);
      return setStatus({ tone: "error", text: e.code === "refused" ? t("location.refused") : t("location.none") });
    }

    const record = {
      mineId: profile.mine_id,
      latitude: pos.latitude,
      longitude: pos.longitude,
      observationType: obsType,
      severity,
      notes,
      capturedAt: new Date().toISOString(),
    };
    const reset = () => { setNotes(""); setPhoto(null); };

    // With no signal the record -- photo included -- is stored on the
    // device rather than lost.
    const queue = async (why) => {
      await enqueue("inspection", { ...record, photoBlob: photo || null }, profile?.profile_id);
      setStatus({ tone: "info", text: why });
      reset();
    };

    try {
      if (!isOnline()) {
        await queue(`${t("savedOffline")} (${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)})`);
        return;
      }
      const token = await getAccessToken();
      const photoPath = photo ? await uploadEvidence(profile.mine_id, "inspections", photo) : "";
      const res = await logFieldInspection(token, { ...record, photoPath });
      if (res?.error) {
        setStatus({ tone: "error", text: res.error });
      } else {
        const where = res.within_geofence === false
          ? ` This position is ${formatDistance(res.distance_from_mine_m)} from the mine's recorded location, so it has been flagged for review.`
          : "";
        setStatus({
          tone: res.within_geofence === false ? "error" : "success",
          text: `Recorded at ${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}. `
            + (res.action_due_date ? `Corrective action due ${res.action_due_date}.` : "") + where,
        });
        reset();
        loadRecent();
      }
    } catch (e) {
      // Being "online" is not the same as reaching the server. A failed
      // request queues rather than discarding the finding.
      try {
        await queue("Could not reach the server, so this is saved on your device and will be sent later.");
      } catch {
        setStatus({ tone: "error", text: String(e.message || e) });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Layout title={t("insp.title")} subtitle="">
      <Card title={t("insp.fromPaper")} style={{ maxWidth: 560 }}>
        <OcrCapture onExtract={applyExtract} />
      </Card>

      <Card title={t("insp.record")} style={{ maxWidth: 560 }}>
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        <Field label={t("insp.observation")}>
          <select value={obsType} onChange={(e) => setObsType(e.target.value)}>
            {OBSERVATIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label={t("insp.severity")}>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {["Low", "Medium", "High", "Critical"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label={t("insp.notes")}>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder={t("insp.notesHint")} />
        </Field>
        <PhotoInput value={photo} onChange={setPhoto} />
        <Button onClick={submit} disabled={submitting}>
          {submitting ? t("insp.recording") : t("insp.submit")}
        </Button>
        <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "10px 0 0" }}>
          {t("insp.locHint")}
        </p>
      </Card>

      <Card title={t("insp.recent")}>
        <Table
          columns={[
            { key: "timestamp", label: "When", width: 170, nowrap: true,
              render: (r) => (r.timestamp ? new Date(r.timestamp).toLocaleString() : "—") },
            { key: "observation_type", label: "Observation" },
            { key: "severity", label: "Severity", width: 110, render: (r) => <Badge>{r.severity}</Badge> },
            { key: "notes", label: "Notes", render: (r) => r.notes || "—" },
            { key: "geo", label: "Location", width: 150,
              render: (r) => <GeoBadge within={r.within_geofence} distance={r.distance_from_mine_m} /> },
            { key: "photo", label: "Photo", width: 70, render: (r) => <EvidenceLink path={r.photo_url} /> },
            { key: "action", label: "Action", width: 120,
              render: (r) => <Badge>{r.corrective_action_status || "Open"}</Badge> },
          ]}
          rows={recent}
          countLabel="inspections"
          severityOf={(r) => r.severity}
          empty="No inspections recorded here yet. Your first one will appear in this list."
        />
      </Card>

      <MineMap />

      <ChatPanel />
    </Layout>
  );
}

export default function InspectorDashboard() {
  return (
    <RoleGuard allowedRoles={["inspector"]}>
      <InspectorContent />
    </RoleGuard>
  );
}
