import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import { Card, StatStrip, Table, Badge, Field, Button, Notice } from "../../components/ui";
import { PhotoInput, EvidenceLink, GeoBadge } from "../../components/Evidence";
import { useAuth } from "../../lib/useAuth";
import { useT } from "../../lib/i18n";
import { supabase } from "../../lib/supabase";
import { getPosition, isOnline } from "../../lib/geo";
import { uploadEvidence } from "../../lib/evidence";
import { enqueue } from "../../lib/offlineQueue";

// Incident reporting and investigation.
//
// Anyone attached to a mine can report. The database derives severity,
// decides whether the incident must be notified to DGMS and by when, and
// alerts the mine official -- and for serious incidents corporate
// management and the regulator -- the moment the report lands. The
// report itself can never be edited afterwards; the investigation is
// recorded alongside it, and a notifiable incident cannot be closed until
// the DGMS notice is on record.

const TYPES = ["Near Miss", "Minor Injury", "Serious Injury", "Fatal Accident", "Dangerous Occurrence",
  "Fire", "Inundation", "Roof/Side Fall", "Equipment Failure", "Environmental Release"];
const SERIOUS = new Set(["Serious Injury", "Fatal Accident", "Dangerous Occurrence", "Fire", "Inundation", "Roof/Side Fall"]);
const REPORTERS = ["worker", "inspector", "contractor_manager", "mine_official"];
const INVESTIGATORS = ["mine_official", "corporate_admin", "admin"];

const fmt = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const localNow = () => {
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function ReportForm({ onReported }) {
  const { profile } = useAuth();
  const { t } = useT();
  const blank = { incident_type: "Near Miss", occurred_at: localNow(), location_description: "",
                  persons_injured: 0, persons_killed: 0, description: "", immediate_action: "" };
  const [f, setF] = useState(blank);
  const [photo, setPhoto] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async () => {
    if (!profile?.mine_id) return setStatus({ tone: "error", text: t("noMine") });
    if (!f.description.trim()) return setStatus({ tone: "error", text: t("inc.needText") });
    setBusy(true);
    // Location is attached when available but never blocks a report: an
    // accident must be reportable even from a phone that refuses GPS.
    let pos = null;
    try { pos = await getPosition({ timeout: 8000 }); } catch { /* reported without a position */ }

    const row = {
      mine_id: profile.mine_id,
      occurred_at: new Date(f.occurred_at).toISOString(),
      incident_type: f.incident_type,
      location_description: f.location_description || null,
      persons_injured: Number(f.persons_injured) || 0,
      persons_killed: Number(f.persons_killed) || 0,
      description: f.description.trim(),
      immediate_action: f.immediate_action.trim() || null,
      latitude: pos?.latitude ?? null,
      longitude: pos?.longitude ?? null,
    };

    const queue = async () => {
      await enqueue("incident", { ...row, photoBlob: photo || null }, profile?.profile_id);
      setStatus({ tone: "info", text: t("savedOffline") });
      setF({ ...blank, occurred_at: localNow() }); setPhoto(null);
    };

    try {
      if (!isOnline()) return await queue();
      if (photo) row.photo_url = await uploadEvidence(profile.mine_id, "incidents", photo);
      const { data, error } = await supabase.from("incidents").insert(row).select("severity, notifiable").single();
      if (error) {
        if (/fetch|network/i.test(error.message)) return await queue();
        return setStatus({ tone: "error", text: error.message });
      }
      const high = ["High", "Critical"].includes(data?.severity);
      setStatus({ tone: "success", text: t("inc.sent") + (high ? t("inc.sentHigh") : ".") });
      setF({ ...blank, occurred_at: localNow() }); setPhoto(null);
      onReported?.();
    } catch (e) {
      try { await queue(); } catch { setStatus({ tone: "error", text: String(e.message || e) }); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("inc.report")} style={{ maxWidth: 640 }}>
      <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>{t("inc.reportHint")}</p>
      {status && <Notice tone={status.tone}>{status.text}</Notice>}
      <div className="formgrid">
        <Field label={t("inc.type")}>
          <select value={f.incident_type} onChange={set("incident_type")}>
            {TYPES.map((x) => <option key={x} value={x}>{t(`type.${x}`)}</option>)}
          </select>
        </Field>
        <Field label={t("inc.when")}>
          <input type="datetime-local" value={f.occurred_at} max={localNow()} onChange={set("occurred_at")} />
        </Field>
      </div>
      <Field label={t("inc.where")}>
        <input value={f.location_description} onChange={set("location_description")} placeholder={t("inc.whereHint")} />
      </Field>
      {f.incident_type !== "Near Miss" && (
        <div className="formgrid">
          <Field label={t("inc.injured")}>
            <input type="number" min="0" value={f.persons_injured} onChange={set("persons_injured")} />
          </Field>
          <Field label={t("inc.killed")}>
            <input type="number" min="0" value={f.persons_killed} onChange={set("persons_killed")} />
          </Field>
        </div>
      )}
      <Field label={t("inc.describe")}>
        <textarea rows={4} value={f.description} onChange={set("description")} />
      </Field>
      <Field label={t("inc.immediate")}>
        <textarea rows={2} value={f.immediate_action} onChange={set("immediate_action")} />
      </Field>
      <PhotoInput value={photo} onChange={setPhoto} />
      <Button onClick={submit} disabled={busy}
        style={SERIOUS.has(f.incident_type) ? { background: "var(--sev-critical)", borderColor: "var(--sev-critical)" } : undefined}>
        {busy ? t("inc.sending") : t("inc.submit")}
      </Button>
    </Card>
  );
}

function Investigation({ incident, onDone, onCancel }) {
  const [notice, setNotice] = useState("");
  const [findings, setFindings] = useState(incident.investigation_findings || "");
  const [cause, setCause] = useState(incident.root_cause || "");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const update = async (values) => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.from("incidents").update(values)
      .eq("incident_id", incident.incident_id).select("incident_id");
    setBusy(false);
    if (error) return setErr(error.message);
    if (!data?.length) return setErr("Not saved. You can only act on incidents at your own mine.");
    onDone();
  };

  return (
    <div style={{ background: "var(--primary-wash)", borderLeft: "3px solid var(--primary)", padding: 16,
                  marginBottom: 16, borderRadius: 3 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{incident.incident_type} — {fmt(incident.occurred_at)}</div>
      <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>{incident.description}</p>
      {err && <Notice tone="error">{err}</Notice>}

      {incident.status === "Reported" && (
        <Button onClick={() => update({ status: "Under Investigation" })} disabled={busy} style={{ marginBottom: 14 }}>
          Start investigation
        </Button>
      )}

      {incident.notifiable && !incident.dgms_notified && (
        <div style={{ marginBottom: 14 }}>
          <Field label={`DGMS notice reference (due by ${fmt(incident.dgms_notice_due_at)})`}>
            <input value={notice} onChange={(e) => setNotice(e.target.value)} placeholder="e.g. DGMS/DHN/2026/114" />
          </Field>
          <Button variant="secondary" disabled={busy || !notice.trim()}
            onClick={() => update({ dgms_notified: true, dgms_notice_ref: notice.trim() })}>
            Record notice sent to DGMS
          </Button>
        </div>
      )}

      {incident.status !== "Reported" && (
        <>
          <Field label="Investigation findings">
            <textarea rows={3} value={findings} onChange={(e) => setFindings(e.target.value)} />
          </Field>
          <Field label="Root cause">
            <input value={cause} onChange={(e) => setCause(e.target.value)} placeholder="e.g. Reversing alarm not maintained" />
          </Field>
          <Button disabled={busy || (incident.notifiable && !incident.dgms_notified)}
            onClick={() => update({ status: "Closed", investigation_findings: findings, root_cause: cause })}>
            Close incident
          </Button>
          <Button variant="secondary" disabled={busy} style={{ marginLeft: 8 }}
            onClick={() => update({ investigation_findings: findings, root_cause: cause })}>
            Save progress
          </Button>
          {incident.notifiable && !incident.dgms_notified && (
            <span style={{ fontSize: 13, color: "var(--ink-soft)", marginLeft: 12 }}>
              Closing needs the DGMS notice on record.
            </span>
          )}
        </>
      )}
      <div style={{ marginTop: 12 }}>
        <Button variant="quiet" onClick={onCancel}>Done</Button>
      </div>
    </div>
  );
}

function IncidentsContent() {
  const { profile } = useAuth();
  const { t } = useT();
  const [rows, setRows] = useState(null);
  const [working, setWorking] = useState(null);
  const wide = ["corporate_admin", "regulator", "admin"].includes(profile?.role);
  const canReport = REPORTERS.includes(profile?.role);
  const canInvestigate = INVESTIGATORS.includes(profile?.role);

  const load = async () => {
    const { data } = await supabase.from("incident_view").select("*")
      .order("occurred_at", { ascending: false }).limit(500);
    setRows(data || []);
  };
  useEffect(() => { load(); }, [profile?.profile_id]);

  const list = rows || [];
  const since30 = Date.now() - 30 * 864e5;
  const recent = list.filter((r) => new Date(r.occurred_at).getTime() >= since30);
  const noticeOverdue = list.filter((r) => r.notice_overdue);
  const openCount = list.filter((r) => r.status !== "Closed").length;

  return (
    <Layout title={t("inc.title")} subtitle="">
      {canReport && <ReportForm onReported={load} />}

      <StatStrip items={[
        { label: "Reported, last 30 days", value: recent.length },
        { label: "Serious or fatal, last 30 days",
          value: recent.filter((r) => ["High", "Critical"].includes(r.severity)).length, tone: "high" },
        { label: "Still open", value: openCount, tone: openCount ? "medium" : null },
        { label: "DGMS notice overdue", value: noticeOverdue.length, tone: noticeOverdue.length ? "critical" : null },
      ]} />

      <Card title={wide ? "Incidents across all mines" : "Incidents at this mine"}>
        {working && (
          <Investigation incident={working} onCancel={() => setWorking(null)}
            onDone={async () => { await load(); setWorking(null); }} />
        )}
        <Table
          columns={[
            { key: "occurred_at", label: "When", width: 150, nowrap: true, render: (r) => fmt(r.occurred_at) },
            ...(wide ? [{ key: "mine_name", label: "Mine", width: 160,
                          render: (r) => <><strong>{r.mine_name}</strong><div style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>{r.state}</div></> }] : []),
            { key: "incident_type", label: "What", render: (r) => (
                <>
                  <strong>{r.incident_type}</strong>
                  {(r.persons_killed > 0 || r.persons_injured > 0) && (
                    <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                      {" "}· {r.persons_killed ? `${r.persons_killed} killed, ` : ""}{r.persons_injured} injured
                    </span>
                  )}
                  <div style={{ color: "var(--ink-soft)", fontSize: 13.5 }}>{r.description}</div>
                  {r.root_cause && <div style={{ fontSize: 13, marginTop: 2 }}>Root cause: {r.root_cause}</div>}
                </>
              ) },
            { key: "severity", label: "Severity", width: 95, render: (r) => <Badge>{r.severity}</Badge> },
            { key: "dgms", label: "DGMS notice", width: 150, render: (r) => !r.notifiable ? <span style={{ color: "var(--ink-faint)" }}>Not required</span>
                : r.dgms_notified ? <span style={{ color: "var(--sev-low)" }}>Sent · {r.dgms_notice_ref}</span>
                : r.notice_overdue ? <strong style={{ color: "var(--sev-critical)" }}>Overdue</strong>
                : <span>Due {fmt(r.dgms_notice_due_at)}</span> },
            { key: "geo", label: "Location", width: 130,
              render: (r) => <>{r.location_description && <div style={{ fontSize: 13 }}>{r.location_description}</div>}
                               <GeoBadge within={r.within_geofence} distance={r.distance_from_mine_m} /></> },
            { key: "photo", label: "Photo", width: 70, render: (r) => <EvidenceLink path={r.photo_url} /> },
            { key: "status", label: "Status", width: 120, render: (r) => <Badge>{r.status}</Badge> },
            ...(canInvestigate ? [{ key: "act", label: "", width: 100,
              render: (r) => r.status === "Closed" ? null
                : <Button variant="secondary" onClick={() => setWorking(r)}>Act</Button> }] : []),
          ]}
          rows={list}
          countLabel="incidents"
          severityOf={(r) => (r.notice_overdue ? "Critical" : r.status === "Closed" ? "Closed" : r.severity)}
          empty="No incidents reported."
        />
      </Card>
    </Layout>
  );
}

export default function IncidentsPage() {
  return (
    <RoleGuard allowedRoles={[...REPORTERS, "corporate_admin", "regulator", "admin"]}>
      <IncidentsContent />
    </RoleGuard>
  );
}
