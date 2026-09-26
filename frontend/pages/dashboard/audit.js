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

export default function AuditPage() {
  return (
    <RoleGuard allowedRoles={["regulator", "corporate_admin", "admin"]}>
      <AuditContent />
    </RoleGuard>
  );
}
