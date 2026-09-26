import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import { Card, Table, Button, Notice } from "../../components/ui";
import { supabase } from "../../lib/supabase";

// The audit trail, and proof that it has not been altered.
//
// Every entry stores a SHA-256 hash of its own content and of the entry
// before it (migration 08). "Verify" asks the database to recompute the
// whole chain: an edited, deleted or re-ordered entry breaks it at that
// exact point. The table itself cannot be updated or deleted by anyone,
// including the database owner, and the scheduled job publishes the
// latest hash outside the database after every run -- so even a rewrite
// of the entire chain would not match the published record.

const fmt = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" }) : "—");

const TABLE_LABEL = {
  compliance_tracking: "Compliance", geo_inspections: "Inspection / action", incidents: "Incident",
  grievances: "Grievance", ai_risk_flags: "Risk flag", contractors: "Contractor",
  contractor_compliance: "Contractor document", statutory_returns: "Statutory return",
  mine_production_daily: "Production", env_readings: "Environment", attendance_records: "Attendance",
  user_profiles: "User access",
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const short = (v) => {
  if (v == null) return "∅";
  if (typeof v === "string" && ISO.test(v)) return new Date(v).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
};

// Updates are stored as {column: {from, to}}; inserts as the new row.
function Details({ d }) {
  if (!d || typeof d !== "object") return "—";
  // Who acted is already in the "Who" column, and the seal holds the
  // fingerprint, so internal ids and hashes are left out here.
  const noise = /_id$|_by$|created_at|is_synthetic|_hash$|snapshot|^(latitude|longitude)$/;
  const entries = Object.entries(d).filter(([k]) => k !== "mine_id");
  // Each field decides for itself: a change is {from, to}; a redacted or
  // inserted value is shown as it is.
  const isChange = (v) => v && typeof v === "object" && ("from" in v || "to" in v);
  const shown = entries.filter(([k, v]) => !noise.test(k) && v != null && v !== "[redacted]").slice(0, 8);
  return (
    <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>
      {shown.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && "; "}
          {k.replace(/_/g, " ")}: {isChange(v) ? <>{short(v.from)} → <strong style={{ color: "var(--ink)" }}>{short(v.to)}</strong></> : short(v)}
        </span>
      ))}
    </span>
  );
}

function AuditContent() {
  const [rows, setRows] = useState(null);
  const [table, setTable] = useState("");
  const [verify, setVerify] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  const [anchors, setAnchors] = useState(null);
  useEffect(() => {
    supabase.from("audit_anchor_status")
      .select("anchor_id, anchored_at, head_seq, head_hash, status, bitcoin_block, confirmed_at, stamped_text, ots_proof, still_matches")
      .order("anchored_at", { ascending: false }).limit(60)
      .then(({ data }) => setAnchors(data || []));
  }, []);

  const load = async () => {
    let q = supabase.from("audit_trail_view")
      .select("chain_seq, timestamp, action, table_affected, record_id, details, row_hash, actor_name, actor_role")
      .order("chain_seq", { ascending: false }).limit(400);
    if (table) q = q.eq("table_affected", table);
    const { data, error: err } = await q;
    if (err) setError(err.message);
    setRows(data || []);
  };
  useEffect(() => { load(); }, [table]);

  const runVerify = async () => {
    setChecking(true); setVerify(null);
    const { data, error: err } = await supabase.rpc("verify_audit_chain");
    setChecking(false);
    if (err) return setVerify({ ok: false, reason: err.message });
    setVerify(data);
  };

  return (
    <Layout title="Audit trail" subtitle="Every change, who made it, and proof the record is intact">
      {error && <Notice tone="error">{error}</Notice>}

      <Card title="Integrity" severity={verify ? (verify.ok ? "Completed" : "Critical") : undefined}>
        <p style={{ fontSize: 14, color: "var(--ink-soft)", marginTop: -4 }}>
          Each entry is sealed with a SHA-256 hash that includes the entry before it. Verification recomputes
          every hash; if any past entry was altered, removed or reordered, the chain breaks at that entry.
        </p>
        {verify && (verify.ok ? (
          <Notice tone="success">
            Intact. All {Number(verify.checked).toLocaleString()} entries verified at {fmt(verify.verified_at)}.
            <div style={{ fontSize: 12.5, wordBreak: "break-all", marginTop: 4 }}>
              Latest hash: {verify.head_hash}
            </div>
          </Notice>
        ) : (
          <Notice tone="error">
            <strong>Chain broken{verify.broken_at ? ` at entry ${verify.broken_at}` : ""}.</strong> {verify.reason}
          </Notice>
        ))}
        <Button onClick={runVerify} disabled={checking}>{checking ? "Verifying" : "Verify the audit chain"}</Button>
      </Card>

      <Anchors rows={anchors} />

      <Card title="Changes" action={
        <select value={table} onChange={(e) => setTable(e.target.value)} style={{ width: 220 }}>
          <option value="">All records</option>
          {Object.entries(TABLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      }>
        <Table
          columns={[
            { key: "chain_seq", label: "#", width: 70, align: "right" },
            { key: "timestamp", label: "When", width: 180, nowrap: true, render: (r) => fmt(r.timestamp) },
            { key: "actor", label: "Who", width: 170, render: (r) => r.actor_name
                ? <><strong>{r.actor_name}</strong><div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>{(r.actor_role || "").replace("_", " ")}</div></>
                : <span style={{ color: "var(--ink-faint)" }}>System job</span> },
            { key: "what", label: "What", width: 170, render: (r) => (
                <>{TABLE_LABEL[r.table_affected] || r.table_affected || "—"}
                  <div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>{r.action}</div></>
              ) },
            { key: "details", label: "Change", render: (r) => <Details d={r.details} /> },
            { key: "row_hash", label: "Seal", width: 100,
              render: (r) => <code title={r.row_hash} style={{ fontSize: 12 }}>{(r.row_hash || "").slice(0, 10)}</code> },
          ]}
          rows={rows || []}
          countLabel="entries"
          empty="No changes recorded yet."
        />
      </Card>
    </Layout>
  );
}

// Save a file the browser already holds (no server round trip).
function saveFile(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// Bitcoin anchors (migration 14). Each is an OpenTimestamps proof that the
// chain's latest hash existed at that time; anyone can check it at
// opentimestamps.org with the two downloaded files, without trusting us.
function Anchors({ rows }) {
  const list = rows || [];
  const broken = list.filter((a) => a.still_matches === false);
  const confirmed = list.filter((a) => a.status === "Confirmed");
  return (
    <Card title="Public blockchain anchors" severity={broken.length ? "Critical" : confirmed.length ? "Completed" : undefined}>
      <p style={{ fontSize: 14, color: "var(--ink-soft)", marginTop: -4 }}>
        Once a day the chain&apos;s latest hash is stamped into the <strong>Bitcoin blockchain</strong> using
        OpenTimestamps. Even someone with full database access cannot rewrite history without the chain
        disagreeing with these public proofs. To check one yourself, download both files and open them at{" "}
        <a href="https://opentimestamps.org" target="_blank" rel="noreferrer">opentimestamps.org</a>.
      </p>
      {broken.length > 0 && (
        <Notice tone="error">
          <strong>{broken.length} anchor{broken.length > 1 ? "s" : ""} no longer match the chain.</strong> The entries
          anchored in Bitcoin have been rewritten since: treat the audit trail after that point as tampered with.
        </Notice>
      )}
      <Table
        columns={[
          { key: "anchored_at", label: "Anchored", width: 180, nowrap: true, render: (a) => fmt(a.anchored_at) },
          { key: "head_seq", label: "Up to entry", width: 110, align: "right" },
          { key: "status", label: "Bitcoin", width: 210, render: (a) => a.status === "Confirmed"
              ? <span style={{ color: "var(--sev-low)" }}>Confirmed in block {Number(a.bitcoin_block).toLocaleString()}</span>
              : <span style={{ color: "var(--ink-soft)" }}>Submitted; confirms in a few hours</span> },
          { key: "still_matches", label: "Matches today's chain", width: 170, render: (a) => a.still_matches
              ? <span style={{ color: "var(--sev-low)" }}>Yes</span>
              : <strong style={{ color: "var(--sev-critical)" }}>No: rewritten</strong> },
          { key: "files", label: "Proof", width: 220, render: (a) => (
              <>
                <Button variant="quiet" onClick={() => saveFile(`audit-anchor-${a.head_seq}.txt`, a.stamped_text, "text/plain")}>Text</Button>
                <Button variant="quiet" style={{ marginLeft: 8 }}
                  onClick={() => saveFile(`audit-anchor-${a.head_seq}.txt.ots`, fromBase64(a.ots_proof), "application/octet-stream")}>
                  .ots proof
                </Button>
              </>
            ) },
        ]}
        rows={list}
        countLabel="anchors"
        severityOf={(a) => (a.still_matches === false ? "Critical" : a.status === "Confirmed" ? "Completed" : "Pending")}
        empty="No anchors yet. The scheduled job creates the first one on its next run."
      />
    </Card>
  );
}

export default function AuditPage() {
  return (
    <RoleGuard allowedRoles={["regulator", "corporate_admin", "admin"]}>
      <AuditContent />
    </RoleGuard>
  );
}
