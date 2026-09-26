import { useEffect, useMemo, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import { Card, StatStrip, Table, Badge, Field, Button, Notice } from "../../components/ui";
import { PhotoInput, EvidenceLink, GeoBadge } from "../../components/Evidence";
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";
import { uploadEvidence } from "../../lib/evidence";

// Corrective actions: from a finding to a verified fix.
//
//   Open ─▶ In Progress ─▶ Action Taken ─▶ Closed
//     ▲                         │
//     └──────── Reopened ◀──────┘   (verification failed)
//
// The mine official records what was done, with a photo (mandatory for a
// Critical finding). Someone else -- an inspector at the mine, or corporate
// management -- checks it and either closes the finding or reopens it with
// a reason. The database enforces every one of these rules (migration 07),
// including that nobody can verify their own fix; this page only offers
// the steps a person is allowed to take.

const VIEWS = {
  work: { label: "Needs action", match: (r) => ["Open", "In Progress", "Reopened", "Overdue"].includes(r.corrective_action_status) },
  verify: { label: "Awaiting verification", match: (r) => r.corrective_action_status === "Action Taken" },
  closed: { label: "Closed", match: (r) => r.corrective_action_status === "Closed" },
  all: { label: "All", match: () => true },
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString([], { dateStyle: "medium" }) : "—");

function ActionPanel({ row, role, me, onDone, onClose }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const canFix = ["mine_official", "corporate_admin", "admin"].includes(role)
    && ["Open", "In Progress", "Reopened", "Overdue"].includes(row.corrective_action_status);
  const canVerify = ["inspector", "corporate_admin", "admin"].includes(role)
    && row.corrective_action_status === "Action Taken";
  const ownFix = row.action_submitted_by && row.action_submitted_by === me;

  const update = async (values) => {
    setBusy(true); setErr(null);
    try {
      const { data, error } = await supabase.from("geo_inspections").update(values)
        .eq("inspection_id", row.inspection_id).select("inspection_id");
      if (error) throw new Error(error.message);
      if (!data?.length) throw new Error("Not saved. You can only act on findings at your own mine.");
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally { setBusy(false); }
  };

  const recordFix = async () => {
    if (!text.trim()) return setErr("Describe what was done.");
    if (row.severity === "Critical" && !photo) return setErr("A Critical finding needs a photo of the fix.");
    setBusy(true); setErr(null);
    let path = null;
    try {
      if (photo) path = await uploadEvidence(row.mine_id, "actions", photo);
    } catch (e) { setBusy(false); return setErr(e.message); }
    await update({ corrective_action_status: "Action Taken", action_taken: text.trim(), action_photo_url: path });
  };

  return (
    <div style={{ background: "var(--primary-wash)", borderLeft: "3px solid var(--primary)", padding: 16,
                  marginBottom: 16, borderRadius: 3 }}>
      <div style={{ fontWeight: 600 }}>{row.observation_type} · {row.severity}</div>
      <p style={{ fontSize: 14, color: "var(--ink-soft)", margin: "4px 0 10px" }}>
        {row.notes || "No notes."} Recorded {fmtDate(row.timestamp)} by {row.inspector_name || "an inspector"}.
        {" "}<EvidenceLink path={row.photo_url}>Finding photo</EvidenceLink>
      </p>
      {row.verification_note && (
        <Notice tone="error">Reopened after verification: {row.verification_note}</Notice>
      )}
      {err && <Notice tone="error">{err}</Notice>}

      {canFix && (
        <>
          {row.corrective_action_status !== "In Progress" && (
            <Button variant="secondary" disabled={busy} style={{ marginBottom: 14 }}
              onClick={() => update({ corrective_action_status: "In Progress" })}>
              Mark work started
            </Button>
          )}
          <Field label="What was done to fix it?">
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Loose earthing on switchgear panel 3 re-terminated and tested at 0.6 Ω" />
          </Field>
          <PhotoInput value={photo} onChange={setPhoto}
            label={row.severity === "Critical" ? "Photo of the fix (required for Critical)" : "Photo of the fix"} />
          <Button onClick={recordFix} disabled={busy}>{busy ? "Saving" : "Record fix for verification"}</Button>
        </>
      )}

      {row.corrective_action_status === "Action Taken" && (
        <div style={{ margin: "4px 0 12px", fontSize: 14 }}>
          <strong>Fix recorded</strong> by {row.action_by_name || "the mine"} on {fmtDate(row.action_submitted_at)}:
          <div style={{ margin: "4px 0" }}>{row.action_taken}</div>
          <EvidenceLink path={row.action_photo_url}>Photo of the fix</EvidenceLink>
        </div>
      )}

      {canVerify && (ownFix ? (
        <Notice>You recorded this fix, so someone else has to verify it.</Notice>
      ) : (
        <>
          <Field label="Verification note (required to reopen)">
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="What you checked on site" />
          </Field>
          <Button disabled={busy} onClick={() => update({ corrective_action_status: "Closed", verification_note: note || null })}>
            Verified, close finding
          </Button>
          <Button variant="secondary" disabled={busy || !note.trim()} style={{ marginLeft: 8 }}
            onClick={() => update({ corrective_action_status: "Reopened", verification_note: note.trim() })}>
            Not fixed, reopen
          </Button>
        </>
      ))}

      <div style={{ marginTop: 12 }}><Button variant="quiet" onClick={onClose}>Done</Button></div>
    </div>
  );
}

function ActionsContent() {
  const { profile } = useAuth();
  const role = profile?.role;
  const wide = ["corporate_admin", "regulator", "admin"].includes(role);
  const [rows, setRows] = useState(null);
  const [view, setView] = useState(role === "inspector" ? "verify" : "work");
  const [working, setWorking] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    const { data, error: err } = await supabase.from("corrective_action_view").select("*")
      .order("action_due_date", { ascending: true }).limit(2000);
    if (err) setError(err.message);
    setRows(data || []);
  };
  useEffect(() => { load(); }, [profile?.profile_id]);

  const list = useMemo(() => rows || [], [rows]);
  const shown = useMemo(() => list.filter(VIEWS[view].match), [list, view]);
  const late = list.filter((r) => r.is_late).length;
  const awaiting = list.filter((r) => r.corrective_action_status === "Action Taken").length;
  const reopened = list.filter((r) => r.reopened_count > 0 && r.corrective_action_status !== "Closed").length;
  const outside = list.filter((r) => r.within_geofence === false).length;
  const actionable = !["regulator"].includes(role);

  return (
    <Layout title="Corrective actions" subtitle={wide ? "All mines" : ""}>
      {error && <Notice tone="error">{error}</Notice>}
      <StatStrip items={[
        { label: "Past their action deadline", value: late, tone: late ? "critical" : null },
        { label: "Fixed, awaiting verification", value: awaiting, tone: awaiting ? "medium" : null },
        { label: "Reopened after a failed check", value: reopened, tone: reopened ? "high" : null },
        { label: "Findings recorded off-site", value: outside, tone: outside ? "high" : null,
          note: "Outside the mine's geo-fence" },
      ]} />

      <Card title="Findings" action={
        <div className="segmented" role="group" aria-label="Show">
          {Object.entries(VIEWS).map(([k, v]) => (
            <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{v.label}</button>
          ))}
        </div>
      }>
        {working && (
          <ActionPanel row={working} role={role} me={profile?.profile_id}
            onClose={() => setWorking(null)}
            onDone={async () => { await load(); setWorking(null); }} />
        )}
        <Table
          columns={[
            ...(wide ? [{ key: "mine_name", label: "Mine", width: 160,
              render: (r) => <><strong>{r.mine_name}</strong><div style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>{r.state}</div></> }] : []),
            { key: "obs", label: "Finding", render: (r) => (
                <>
                  <strong>{r.observation_type}</strong>
                  <div style={{ color: "var(--ink-soft)", fontSize: 13.5 }}>{r.notes}</div>
                  {r.reopened_count > 0 && (
                    <div style={{ color: "var(--sev-high)", fontSize: 13 }}>Reopened {r.reopened_count}× after verification</div>
                  )}
                </>
              ) },
            { key: "severity", label: "Severity", width: 95, render: (r) => <Badge>{r.severity}</Badge> },
            { key: "due", label: "Action due", width: 130, nowrap: true, render: (r) => r.corrective_action_status === "Closed"
                ? <span style={{ color: "var(--ink-faint)" }}>Closed {fmtDate(r.verified_at)}</span>
                : r.is_late ? <strong style={{ color: "var(--sev-critical)" }}>{Math.abs(r.days_left)} days late</strong>
                : <>{fmtDate(r.action_due_date)}<div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>{r.days_left} days left</div></> },
            { key: "geo", label: "Recorded", width: 140, render: (r) => <GeoBadge within={r.within_geofence} distance={r.distance_from_mine_m} /> },
            { key: "status", label: "Status", width: 130, render: (r) => <Badge>{r.corrective_action_status}</Badge> },
            ...(actionable ? [{ key: "act", label: "", width: 90,
              render: (r) => r.corrective_action_status === "Closed" ? null
                : <Button variant="secondary" onClick={() => setWorking(r)}>Open</Button> }] : []),
          ]}
          rows={shown}
          countLabel="findings"
          severityOf={(r) => (r.is_late ? "Critical" : r.corrective_action_status === "Closed" ? "Closed" : r.severity)}
          empty={view === "verify" ? "No fixes are waiting to be verified." : "Nothing here."}
        />
      </Card>
    </Layout>
  );
}

export default function ActionsPage() {
  return (
    <RoleGuard allowedRoles={["mine_official", "inspector", "corporate_admin", "regulator", "admin"]}>
      <ActionsContent />
    </RoleGuard>
  );
}
