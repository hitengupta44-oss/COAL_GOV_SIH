import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import OcrCapture from "../../components/OcrCapture";
import MineMap from "../../components/MineMap";
import { Card, Table, Badge, Field, Button, Notice } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { logFieldInspection } from "../../lib/api";
import { supabase } from "../../lib/supabase";

const OBSERVATIONS = ["Safety Equipment Check", "Ventilation Inspection", "Slope Stability",
  "Electrical Safety", "Housekeeping", "Water Accumulation", "PPE Compliance"];

function InspectorContent() {
  const { profile, getAccessToken } = useAuth();
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
      .select("observation_type, severity, notes, timestamp, latitude, longitude")
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
  // not from whatever the inspector types afterwards.
  const submit = async () => {
    if (!profile?.mine_id) return setStatus({ tone: "error", text: "No mine assigned to your account. Ask an administrator to set one." });
    if (!navigator.geolocation) return setStatus({ tone: "error", text: "This device can't provide a location, which is required for a geo-tagged inspection." });

    setSubmitting(true);
    setStatus({ tone: "info", text: "Getting your location." });
    const token = await getAccessToken();

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const res = await logFieldInspection(token, {
            mineId: profile.mine_id,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            observationType: obsType,
            severity,
            notes,
          });
          if (res?.error) setStatus({ tone: "error", text: res.error });
          else {
            setStatus({ tone: "success", text: `Recorded at ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}.` });
            setNotes("");
            loadRecent();
          }
        } catch (e) {
          setStatus({ tone: "error", text: String(e.message || e) });
        } finally { setSubmitting(false); }
      },
      () => {
        setStatus({ tone: "error", text: "Location access was refused. Allow it to record a geo-tagged inspection." });
        setSubmitting(false);
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  return (
    <Layout title="Inspections" subtitle="">
      <Card title="From a paper sheet" style={{ maxWidth: 560 }}>
        <OcrCapture onExtract={applyExtract} />
      </Card>

      <Card title="Record an inspection" style={{ maxWidth: 560 }}>
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        <Field label="Observation">
          <select value={obsType} onChange={(e) => setObsType(e.target.value)}>
            {OBSERVATIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Severity">
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {["Low", "Medium", "High", "Critical"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Notes">
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="What did you observe?" />
        </Field>
        <Button onClick={submit} disabled={submitting}>
          {submitting ? "Recording" : "Record inspection"}
        </Button>
        <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "10px 0 0" }}>
          Your location is captured automatically when you record.
        </p>
      </Card>

      <Card title="Recorded at this mine">
        <Table
          columns={[
            { key: "timestamp", label: "When", width: 170, nowrap: true,
              render: (r) => (r.timestamp ? new Date(r.timestamp).toLocaleString() : "—") },
            { key: "observation_type", label: "Observation" },
            { key: "severity", label: "Severity", width: 110, render: (r) => <Badge>{r.severity}</Badge> },
            { key: "notes", label: "Notes", render: (r) => r.notes || "—" },
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
