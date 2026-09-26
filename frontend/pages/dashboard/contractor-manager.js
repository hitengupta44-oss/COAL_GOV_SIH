import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import MineMap from "../../components/MineMap";
import AlertsPanel from "../../components/AlertsPanel";
import { Card, StatStrip, Table, Badge, Button, Notice, Field } from "../../components/ui";
import { PhotoInput, EvidenceLink } from "../../components/Evidence";
import { uploadEvidence } from "../../lib/evidence";

const DOC_TYPES = ["Safety training certificate", "Workmen compensation insurance", "PF registration",
  "Contract labour licence", "ESI registration", "Blasting licence"];

// Bringing a contractor onto the register, and recording their statutory
// documents with the scanned copy attached. The database limits both to
// the manager's own mine, and the audit trail records who added what.
function AddContractor({ profile, onAdded }) {
  const blank = { contractor_name: "", contract_type: "", contract_start: "", contract_end: "", contract_value_lakh_inr: "" };
  const [f, setF] = useState(blank);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.contractor_name.trim()) return setMsg({ tone: "error", text: "Enter the contractor's name." });
    if (f.contract_start && f.contract_end && f.contract_end < f.contract_start)
      return setMsg({ tone: "error", text: "The contract cannot end before it starts." });
    setBusy(true); setMsg(null);
    const { error } = await supabase.from("contractors").insert({
      contractor_name: f.contractor_name.trim(), contract_type: f.contract_type || null,
      contract_start: f.contract_start || null, contract_end: f.contract_end || null,
      contract_value_lakh_inr: f.contract_value_lakh_inr === "" ? null : Number(f.contract_value_lakh_inr),
      mine_id: profile.mine_id, subsidiary_id: profile.subsidiary_id ?? null,
      status: "Active", is_synthetic: false,
    });
    setBusy(false);
    if (error) return setMsg({ tone: "error", text: error.message });
    setMsg({ tone: "success", text: `${f.contractor_name} added and sent for approval. Record their four core `
      + "documents next: the mine official cannot approve until they are on record and in date." });
    setF(blank);
    onAdded();
  };

  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)} style={{ marginBottom: 20 }}>Add a contractor</Button>;
  return (
    <Card title="Add a contractor">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="formgrid">
        <Field label="Name"><input value={f.contractor_name} onChange={set("contractor_name")} /></Field>
        <Field label="Scope of work"><input value={f.contract_type} onChange={set("contract_type")} placeholder="e.g. Overburden removal" /></Field>
        <Field label="Contract starts"><input type="date" value={f.contract_start} onChange={set("contract_start")} /></Field>
        <Field label="Contract ends"><input type="date" value={f.contract_end} onChange={set("contract_end")} /></Field>
        <Field label="Value (₹ lakh)"><input type="number" min="0" value={f.contract_value_lakh_inr} onChange={set("contract_value_lakh_inr")} /></Field>
      </div>
      <Button onClick={save} disabled={busy}>{busy ? "Adding" : "Add contractor"}</Button>
      <Button variant="quiet" style={{ marginLeft: 12 }} onClick={() => setOpen(false)}>Close</Button>
    </Card>
  );
}

function RecordDocument({ profile, contractors, onSaved }) {
  const blank = { contractor_id: "", document_type: DOC_TYPES[0], reference_no: "", issued_on: "", valid_until: "" };
  const [f, setF] = useState(blank);
  const [file, setFile] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const mine = contractors.filter((c) => c.mine_id === profile.mine_id);

  const save = async () => {
    if (!f.contractor_id) return setMsg({ tone: "error", text: "Choose the contractor." });
    if (!f.valid_until) return setMsg({ tone: "error", text: "Enter the date the document is valid until." });
    setBusy(true); setMsg(null);
    try {
      const document_url = file ? await uploadEvidence(profile.mine_id, "contractor-documents", file) : null;
      const { error } = await supabase.from("contractor_compliance").insert({
        contractor_id: f.contractor_id, document_type: f.document_type, reference_no: f.reference_no || null,
        issued_on: f.issued_on || null, valid_until: f.valid_until, document_url, status: "Valid",
      });
      if (error) throw new Error(error.message);
      setMsg({ tone: "success", text: "Document recorded." });
      setF({ ...blank, contractor_id: f.contractor_id }); setFile(null);
      onSaved();
    } catch (e) {
      setMsg({ tone: "error", text: e.message });
    } finally { setBusy(false); }
  };

  return (
    <Card title="Record a document">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="formgrid">
        <Field label="Contractor">
          <select value={f.contractor_id} onChange={set("contractor_id")}>
            <option value="">Choose</option>
            {mine.map((c) => <option key={c.contractor_id} value={c.contractor_id}>{c.contractor_name}</option>)}
          </select>
        </Field>
        <Field label="Document">
          <select value={f.document_type} onChange={set("document_type")}>
            {DOC_TYPES.map((d) => <option key={d}>{d}</option>)}
          </select>
        </Field>
        <Field label="Reference no."><input value={f.reference_no} onChange={set("reference_no")} /></Field>
        <Field label="Issued on"><input type="date" value={f.issued_on} onChange={set("issued_on")} /></Field>
        <Field label="Valid until"><input type="date" value={f.valid_until} onChange={set("valid_until")} /></Field>
      </div>
      <PhotoInput value={file} onChange={setFile} accept="image/*,application/pdf" capture={false}
        label="Scanned copy (photo or PDF)" />
      <Button onClick={save} disabled={busy}>{busy ? "Saving" : "Record document"}</Button>
    </Card>
  );
}
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";

function ContractorContent() {
  const { profile } = useAuth();
  const [rows, setRows] = useState(null);
  const [docs, setDocs] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    // The views do the date arithmetic, so "expired" means the same thing
    // here as it does to the alerts engine and the assistant.
    let q = supabase.from("contractor_register_view").select("*").order("contract_end");
    if (profile?.subsidiary_id) q = q.eq("subsidiary_id", profile.subsidiary_id);
    const { data } = await q;
    setRows(data || []);

    const { data: d } = await supabase
      .from("contractor_compliance_view")
      .select("contractor_name, document_type, computed_status, valid_until, days_to_expiry, document_url")
      .in("computed_status", ["Expired", "Expiring", "Missing"])
      .order("days_to_expiry", { nullsFirst: true })
      .limit(500);
    setDocs(d || []);
  };

  useEffect(() => { load(); }, [profile?.subsidiary_id]);

  // A rejected contractor goes back into review once the problem is fixed.
  const resubmit = async (c) => {
    setBusyId(c.contractor_id); setError(null);
    const { data, error: err } = await supabase.from("contractors").update({ status: "Under Review" })
      .eq("contractor_id", c.contractor_id).select();
    setBusyId(null);
    if (err) return setError(`Could not resubmit: ${err.message}`);
    if (!data?.length) return setError("Not saved. You can only resubmit contractors at your own mine.");
    load();
  };

  const toggleBlacklist = async (id, current) => {
    setBusyId(id); setError(null);
    const { data, error: err } = await supabase
      .from("contractors").update({ blacklisted: !current })
      .eq("contractor_id", id).select();
    setBusyId(null);
    if (err) return setError(`Could not update this contractor: ${err.message}`);
    if (!data?.length) return setError("The change was not saved. You may not have permission to update this contractor.");
    load();
  };

  const list = rows || [];
  const expiringContracts = list.filter((c) => c.contract_state === "Expiring soon").length;
  const expiredDocs = (docs || []).filter((d) => d.computed_status === "Expired").length;
  const blacklisted = list.filter((c) => c.blacklisted).length;

  // A contractor whose paperwork has lapsed shouldn't read as fine just
  // because their contract is in force, so document state overrides the
  // contract state when colouring the row.
  const rowState = (c) =>
    c.blacklisted ? "Critical"
      : c.status === "Rejected" ? "High"
      : c.status === "Under Review" ? "Pending"
      : c.expired_documents > 0 ? "Critical"
      : c.contract_state === "Contract expired" ? "High"
      : c.contract_state === "Expiring soon" ? "Medium"
      : "Low";

  return (
    <Layout title="Contractors" subtitle="">
      {error && <Notice tone="error">{error}</Notice>}

      <StatStrip
        items={[
          { label: "Contracts in force", value: list.filter((c) => c.contract_state === "In force").length },
          { label: "Awaiting approval", value: list.filter((c) => c.status === "Under Review").length,
            tone: list.some((c) => c.status === "Under Review") ? "medium" : null },
          { label: "Contracts ending within 60 days", value: expiringContracts, tone: expiringContracts ? "medium" : null },
          { label: "Lapsed documents", value: expiredDocs, tone: expiredDocs ? "critical" : null, note: "Blocks work on site" },
          { label: "Blacklisted", value: blacklisted, tone: blacklisted ? "critical" : null },
        ]}
      />

      <AlertsPanel />

      {profile?.mine_id && (
        <>
          <AddContractor profile={profile} onAdded={load} />
          <RecordDocument profile={profile} contractors={list} onSaved={load} />
        </>
      )}

      <Card title="Documents needing attention">
        <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
          A contractor cannot lawfully put people on site with a lapsed safety
          certificate, insurance or labour licence. These need renewing.
        </p>
        <Table
          columns={[
            { key: "contractor_name", label: "Contractor", render: (d) => <strong>{d.contractor_name}</strong> },
            { key: "document_type", label: "Document" },
            { key: "valid_until", label: "Valid until", width: 120, nowrap: true,
              render: (d) => d.valid_until || "Not on record" },
            { key: "days_to_expiry", label: "", width: 150, nowrap: true,
              render: (d) => d.days_to_expiry == null ? "—"
                : d.days_to_expiry < 0 ? `${Math.abs(d.days_to_expiry)} days overdue`
                : `${d.days_to_expiry} days left` },
            { key: "computed_status", label: "Status", width: 110,
              render: (d) => <Badge>{d.computed_status === "Expiring" ? "Medium" : d.computed_status === "Expired" ? "Critical" : "High"}</Badge> },
            { key: "document_url", label: "Copy", width: 70, render: (d) => <EvidenceLink path={d.document_url} /> },
          ]}
          rows={docs || []}
          countLabel="documents"
          severityOf={(d) => d.computed_status === "Expired" ? "Critical" : d.computed_status === "Missing" ? "High" : "Medium"}
          empty="Every contractor's paperwork is current."
        />
      </Card>

      <Card title="Contract register">
        <Table
          columns={[
            { key: "contractor_name", label: "Contractor", render: (c) => <strong>{c.contractor_name}</strong> },
            { key: "contract_type", label: "Scope" },
            { key: "contract_end", label: "Ends", width: 115, nowrap: true },
            { key: "contract_state", label: "Contract", width: 160, render: (c) => (
                <>
                  <span style={{ whiteSpace: "nowrap" }}>{c.contract_state}</span>
                  {c.status === "Rejected" && c.review_note && (
                    <div style={{ fontSize: 12.5, color: "var(--sev-high)" }}>
                      {c.reviewed_by_name ? `${c.reviewed_by_name}: ` : ""}{c.review_note}
                    </div>
                  )}
                </>
              ) },
            { key: "document_gaps", label: "Core documents", width: 190, render: (c) => (c.document_gaps || []).length
                ? <span style={{ fontSize: 13, color: "var(--sev-high)" }}>Missing or lapsed: {c.document_gaps.join(", ")}</span>
                : <span style={{ fontSize: 13, color: "var(--sev-low)" }}>All in date</span> },
            { key: "expired_documents", label: "Lapsed docs", width: 110, align: "right",
              render: (c) => c.expired_documents || 0 },
            { key: "act", label: "", width: 130,
              render: (c) => c.status === "Rejected" ? (
                <Button variant="secondary" disabled={busyId === c.contractor_id}
                  onClick={() => resubmit(c)}>Resubmit</Button>
              ) : (
                <Button variant="secondary" disabled={busyId === c.contractor_id}
                  onClick={() => toggleBlacklist(c.contractor_id, c.blacklisted)}>
                  {c.blacklisted ? "Remove flag" : "Blacklist"}
                </Button>
              ) },
          ]}
          rows={list}
          countLabel="contractors"
          severityOf={rowState}
          empty="No contractors on record for your subsidiary."
        />
      </Card>

      <MineMap />

      <ChatPanel />
    </Layout>
  );
}

export default function ContractorManagerDashboard() {
  return (
    <RoleGuard allowedRoles={["contractor_manager"]}>
      <ContractorContent />
    </RoleGuard>
  );
}
