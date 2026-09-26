import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import { Card, StatStrip, Table, Badge, Field, Button, Notice } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";
import { loadPdf } from "../../lib/pdf";

// Statutory returns and their approval.
//
//   Mine official:  prepare -> (review figures) -> submit
//   Corporate:      approve, or send back with a reason -> official resubmits
//   Regulator:      sees a return only once it has been approved
//
// The figures are not typed by anyone. The database generates them from
// the live records when the return is prepared, regenerates them at
// submission, and fingerprints them (SHA-256). The reviewer approves that
// exact content -- the database refuses a reviewer's attempt to change it
// -- and the fingerprint printed on the PDF lets anyone confirm later that
// the document is the one that was approved.

const TYPES = ["Monthly Safety & Compliance Return", "Monthly Production Return", "Quarterly Environmental Return"];
const fmt = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const monthLabel = (d) => new Date(d).toLocaleDateString([], { month: "long", year: "numeric" });

function periodFor(type, monthValue) {
  const [y, m] = monthValue.split("-").map(Number);
  if (type.startsWith("Quarterly")) {
    const q0 = Math.floor((m - 1) / 3) * 3;                 // first month of the quarter
    const start = new Date(Date.UTC(y, q0, 1));
    const end = new Date(Date.UTC(y, q0 + 3, 0));
    return [start, end];
  }
  return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0))];
}
const iso = (d) => d.toISOString().slice(0, 10);

// The sections each return type leads with. Every return carries the full
// snapshot; this only decides what is shown first and printed.
const SECTIONS = {
  "Monthly Safety & Compliance Return": ["compliance", "inspections", "incidents", "attendance", "grievances"],
  "Monthly Production Return": ["production", "attendance", "incidents"],
  "Quarterly Environmental Return": ["environment", "compliance", "incidents"],
};
const LABELS = {
  compliance: "Statutory compliance", inspections: "Inspections and corrective action", incidents: "Incidents",
  production: "Production", environment: "Environment", attendance: "Attendance", grievances: "Grievances",
};
const human = (k) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const val = (v) => (v && typeof v === "object" ? Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(", ") || "none"
  : typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v ?? "—"));

function Snapshot({ ret }) {
  const snap = ret.snapshot || {};
  const keys = SECTIONS[ret.return_type] || Object.keys(LABELS);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
      {keys.filter((k) => snap[k]).map((k) => (
        <div key={k} style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: 12 }}>
          <h3 style={{ marginBottom: 8 }}>{LABELS[k]}</h3>
          <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
            <tbody>
              {Object.entries(snap[k]).map(([f, v]) => (
                <tr key={f}>
                  <td style={{ color: "var(--ink-soft)", padding: "3px 0" }}>{human(f)}</td>
                  <td style={{ textAlign: "right", padding: "3px 0" }} className="figure">{val(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {ret.return_type === "Monthly Safety & Compliance Return" && (snap.overdue_obligations || []).length > 0 && (
        <div style={{ gridColumn: "1 / -1" }}>
          <h3 style={{ marginBottom: 8 }}>Obligations overdue at period end</h3>
          <Table
            columns={[
              { key: "due_date", label: "Due", width: 110, nowrap: true },
              { key: "category", label: "Area", width: 110 },
              { key: "requirement", label: "Requirement" },
              { key: "regulation", label: "Source", width: 220 },
            ]}
            rows={snap.overdue_obligations}
            countLabel="obligations"
            severityOf={() => "Overdue"}
          />
        </div>
      )}
    </div>
  );
}

async function downloadPdf(ret) {
  const JsPDF = await loadPdf();
  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const snap = ret.snapshot || {};
  const mine = snap.mine || {};
  let y = 48;
  doc.setFontSize(15); doc.text(ret.return_type, 40, y); y += 20;
  doc.setFontSize(10.5);
  doc.text(`${mine.name || ret.mine_name}, ${mine.district || ""} ${mine.state || ""} (${mine.subsidiary || "—"})`, 40, y); y += 15;
  doc.text(`Period: ${ret.period_start} to ${ret.period_end}    Status: ${ret.status}${ret.revision ? `    Revision ${ret.revision}` : ""}`, 40, y); y += 20;

  for (const k of SECTIONS[ret.return_type] || []) {
    if (!snap[k]) continue;
    doc.autoTable({
      startY: y, head: [[LABELS[k], ""]],
      body: Object.entries(snap[k]).map(([f, v]) => [human(f), val(v)]),
      theme: "grid", styles: { fontSize: 9.5 }, headStyles: { fillColor: [26, 84, 144] },
      columnStyles: { 1: { halign: "right", cellWidth: 150 } }, margin: { left: 40, right: 40 },
    });
    y = doc.lastAutoTable.finalY + 14;
  }
  if (ret.return_type === "Monthly Safety & Compliance Return" && (snap.overdue_obligations || []).length) {
    doc.autoTable({
      startY: y, head: [["Due", "Area", "Requirement", "Source"]],
      body: snap.overdue_obligations.map((o) => [o.due_date, o.category, o.requirement, o.regulation]),
      theme: "grid", styles: { fontSize: 8.5 }, headStyles: { fillColor: [165, 35, 28] }, margin: { left: 40, right: 40 },
    });
    y = doc.lastAutoTable.finalY + 14;
  }

  doc.autoTable({
    startY: y, head: [["Record of approval", ""]],
    body: [
      ["Prepared by", `${ret.prepared_by_name || "—"}, ${fmt(ret.prepared_at)}`],
      ["Submitted by", `${ret.submitted_by_name || "—"}, ${fmt(ret.submitted_at)}`],
      ["Reviewed by", `${ret.reviewed_by_name || "—"}, ${fmt(ret.reviewed_at)} (${ret.status})`],
      ...(ret.remarks ? [["Mine's remarks", ret.remarks]] : []),
      ...(ret.review_note ? [["Reviewer's note", ret.review_note]] : []),
      ["Content fingerprint (SHA-256)", ret.snapshot_hash || "Not yet submitted"],
    ],
    theme: "grid", styles: { fontSize: 9 }, headStyles: { fillColor: [22, 33, 43] },
    columnStyles: { 0: { cellWidth: 150 } }, margin: { left: 40, right: 40 },
  });
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120);
    doc.text(`Figures generated from platform records on ${fmt(new Date())}. Page ${i} of ${pages}.`, 40, 820);
  }
  const name = `${(mine.name || "mine").replace(/\W+/g, "_")}_${ret.return_type.replace(/\W+/g, "_")}_${ret.period_start}.pdf`;
  doc.save(name);
}

function Prepare({ mineId, onCreated }) {
  const lastMonth = (() => { const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 7); })();
  const [type, setType] = useState(TYPES[0]);
  const [month, setMonth] = useState(lastMonth);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [start, end] = periodFor(type, month);

  const create = async () => {
    setBusy(true); setStatus(null);
    const { data, error } = await supabase.from("statutory_returns").insert({
      mine_id: mineId, return_type: type, period_start: iso(start), period_end: iso(end),
    }).select("return_id").single();
    setBusy(false);
    if (error) {
      return setStatus({ tone: "error", text: /duplicate|unique/i.test(error.message)
        ? "A return of this type already exists for this period. Open it from the list below." : error.message });
    }
    onCreated(data.return_id);
  };

  return (
    <Card title="Prepare a return" style={{ maxWidth: 640 }}>
      {status && <Notice tone={status.tone}>{status.text}</Notice>}
      <div className="formgrid">
        <Field label="Return">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((x) => <option key={x}>{x}</option>)}
          </select>
        </Field>
        <Field label={type.startsWith("Quarterly") ? "Any month in the quarter" : "Month"}>
          <input type="month" value={month} max={new Date().toISOString().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
        </Field>
      </div>
      <p style={{ fontSize: 13.5, color: "var(--ink-soft)", marginTop: -4 }}>
        Covers {iso(start)} to {iso(end)}. The figures are drawn from this mine&apos;s records; review them before submitting.
        Each month&apos;s returns are also prepared automatically on the 1st, due by the 7th.
      </p>
      <Button onClick={create} disabled={busy}>{busy ? "Preparing" : "Prepare draft"}</Button>
    </Card>
  );
}

function ReturnDetail({ ret, role, me, onChanged, onClose }) {
  const [remarks, setRemarks] = useState(ret.remarks || "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const official = role === "mine_official";
  const reviewer = ["corporate_admin", "admin"].includes(role);

  const update = async (values, after) => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.from("statutory_returns").update(values)
      .eq("return_id", ret.return_id).select("return_id");
    setBusy(false);
    if (error) return setErr(error.message);
    if (!data?.length) return setErr("Not saved. You may not have permission for this return.");
    onChanged(after);
  };

  const discard = async () => {
    setBusy(true);
    const { error } = await supabase.from("statutory_returns").delete().eq("return_id", ret.return_id);
    setBusy(false);
    if (error) return setErr(error.message);
    onChanged("closed");
  };

  return (
    <Card title={`${ret.return_type} · ${ret.return_type.startsWith("Quarterly") ? `${ret.period_start} to ${ret.period_end}` : monthLabel(ret.period_start)}`}
      severity={ret.status}
      action={<span><Badge>{ret.status}</Badge> <Button variant="quiet" onClick={onClose} style={{ marginLeft: 12 }}>Close</Button></span>}>
      <p style={{ fontSize: 14, color: "var(--ink-soft)", marginTop: -4 }}>
        {ret.mine_name}, {ret.state}.{" "}
        {ret.auto_prepared ? <>Prepared automatically on {fmt(ret.prepared_at)}</>
          : <>Prepared by {ret.prepared_by_name || "—"} on {fmt(ret.prepared_at)}</>}
        {ret.submitted_at && <>; submitted {fmt(ret.submitted_at)}</>}
        {ret.reviewed_at && <>; {ret.status === "Approved" ? "approved" : "reviewed"} by {ret.reviewed_by_name} on {fmt(ret.reviewed_at)}</>}.
      </p>
      {["Draft", "Returned"].includes(ret.status) && ret.submission_due && (
        <Notice tone={ret.submission_due < new Date().toISOString().slice(0, 10) ? "error" : "info"}>
          {ret.submission_due < new Date().toISOString().slice(0, 10)
            ? <>Overdue: this return was due by <strong>{ret.submission_due}</strong>.</>
            : <>Submit by <strong>{ret.submission_due}</strong>.</>}
          {ret.auto_prepared && " The figures were drawn from the records automatically; review them, add remarks if needed, and submit."}
        </Notice>
      )}
      {ret.status === "Returned" && ret.review_note && <Notice tone="error">Sent back: {ret.review_note}</Notice>}
      {err && <Notice tone="error">{err}</Notice>}

      <Snapshot ret={ret} />

      {ret.snapshot_hash && (
        <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: "12px 0 0", wordBreak: "break-all" }}>
          Content fingerprint (SHA-256): {ret.snapshot_hash}
        </p>
      )}

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
        {official && ["Draft", "Returned"].includes(ret.status) && (
          <>
            <Field label="Remarks for the reviewer (optional)">
              <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)}
                placeholder="Explain anything the figures don't, e.g. a shortfall or a carried-over finding" />
            </Field>
            <Button disabled={busy} onClick={() => update({ status: "Submitted", remarks: remarks || null })}>
              {ret.status === "Returned" ? "Resubmit for approval" : "Submit for approval"}
            </Button>
            <Button variant="secondary" disabled={busy} style={{ marginLeft: 8 }}
              onClick={() => update({ status: "Draft", remarks: remarks || null }, "refresh")}>
              Refresh figures
            </Button>
            {ret.status === "Draft" && (
              <Button variant="quiet" disabled={busy} style={{ marginLeft: 16, color: "var(--sev-critical)" }} onClick={discard}>
                Discard draft
              </Button>
            )}
          </>
        )}

        {reviewer && ret.status === "Submitted" && (ret.submitted_by === me ? (
          <Notice>You submitted this return, so someone else must review it.</Notice>
        ) : (
          <>
            {ret.remarks && <p style={{ fontSize: 14 }}><strong>Mine&apos;s remarks:</strong> {ret.remarks}</p>}
            <Field label="Note (required to send back)">
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Button disabled={busy} onClick={() => update({ status: "Approved", review_note: note || null })}>
              Approve and file with the regulator
            </Button>
            <Button variant="secondary" disabled={busy || !note.trim()} style={{ marginLeft: 8 }}
              onClick={() => update({ status: "Returned", review_note: note.trim() })}>
              Send back
            </Button>
          </>
        ))}

        <Button variant="secondary" style={{ marginLeft: official || reviewer ? 8 : 0 }}
          onClick={() => downloadPdf(ret).catch((e) => setErr(e.message))}>
          Download PDF
        </Button>
      </div>
    </Card>
  );
}

function ReturnsContent() {
  const { profile } = useAuth();
  const role = profile?.role;
  const wide = ["corporate_admin", "regulator", "admin"].includes(role);
  const [rows, setRows] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = async () => {
    const { data } = await supabase.from("statutory_return_view").select("*")
      .order("period_start", { ascending: false }).limit(500);
    // Work waiting on this person first.
    const rank = (r) => (role === "mine_official" ? { Returned: 0, Draft: 1, Submitted: 2, Approved: 3 }
      : { Submitted: 0, Returned: 1, Draft: 2, Approved: 3 })[r.status] ?? 9;
    setRows((data || []).sort((a, b) => rank(a) - rank(b)));
  };
  useEffect(() => { load(); }, [profile?.profile_id]);

  const list = rows || [];
  const current = list.find((r) => r.return_id === openId);
  const count = (s) => list.filter((r) => r.status === s).length;

  return (
    <Layout title="Statutory returns" subtitle={role === "regulator" ? "Approved filings" : ""}>
      <StatStrip items={role === "regulator" ? [
        { label: "Returns filed", value: count("Approved") },
        { label: "Mines filing", value: new Set(list.map((r) => r.mine_id)).size },
      ] : [
        { label: "Awaiting approval", value: count("Submitted"), tone: count("Submitted") ? "medium" : null },
        { label: "Sent back", value: count("Returned"), tone: count("Returned") ? "high" : null },
        { label: "Drafts", value: count("Draft") },
        { label: "Approved", value: count("Approved") },
      ]} />

      {role === "mine_official" && profile?.mine_id && !current && (
        <Prepare mineId={profile.mine_id} onCreated={async (id) => { await load(); setOpenId(id); }} />
      )}

      {current && (
        <ReturnDetail ret={current} role={role} me={profile?.profile_id}
          onClose={() => setOpenId(null)}
          onChanged={async (what) => { await load(); if (what === "closed") setOpenId(null); }} />
      )}

      <Card title="Returns">
        <Table
          columns={[
            ...(wide ? [{ key: "mine_name", label: "Mine", width: 170,
              render: (r) => <><strong>{r.mine_name}</strong><div style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>{r.state}</div></> }] : []),
            { key: "return_type", label: "Return" },
            { key: "period", label: "Period", width: 170, nowrap: true,
              render: (r) => r.return_type.startsWith("Quarterly") ? `${r.period_start} – ${r.period_end}` : monthLabel(r.period_start) },
            { key: "submitted_at", label: "Submitted", width: 190, nowrap: true, render: (r) => r.submitted_at
                ? fmt(r.submitted_at)
                : r.submission_due && r.submission_due < new Date().toISOString().slice(0, 10)
                  ? <strong style={{ color: "var(--sev-critical)" }}>Overdue since {r.submission_due}</strong>
                  : <span style={{ color: "var(--ink-soft)" }}>Due by {r.submission_due || "—"}</span> },
            { key: "auto", label: "", width: 120, nowrap: true, render: (r) => r.auto_prepared
                ? <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Auto-prepared</span> : null },
            { key: "status", label: "Status", width: 120, render: (r) => <Badge>{r.status}</Badge> },
            { key: "open", label: "", width: 90,
              render: (r) => <Button variant="secondary" onClick={() => { setOpenId(r.return_id); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Open</Button> },
          ]}
          rows={list}
          countLabel="returns"
          severityOf={(r) => r.status}
          empty={role === "regulator" ? "No returns have been approved yet." : "No returns yet."}
        />
      </Card>
    </Layout>
  );
}

export default function ReturnsPage() {
  return (
    <RoleGuard allowedRoles={["mine_official", "corporate_admin", "regulator", "admin"]}>
      <ReturnsContent />
    </RoleGuard>
  );
}
