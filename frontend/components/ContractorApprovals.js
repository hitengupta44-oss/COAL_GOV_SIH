import { useEffect, useState } from "react";
import { Card, Table, Button, Field, Notice } from "./ui";
import { useAuth } from "../lib/useAuth";
import { supabase } from "../lib/supabase";

// Contractors waiting to be approved to work.
//
// The database decides who may approve (the mine official or corporate,
// never the person who added the contractor) and refuses approval while
// any of the four core statutory documents is missing or out of date
// (migration 10). This panel shows those gaps up front, so the approver
// knows why the button is disabled rather than meeting an error.
export default function ContractorApprovals({ wide = false }) {
  const { profile } = useAuth();
  const [rows, setRows] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    const { data } = await supabase.from("contractor_register_view")
      .select("contractor_id, contractor_name, contract_type, contract_start, contract_end, mine_id, "
            + "created_by, created_by_name, document_gaps, blacklisted, created_at")
      .eq("status", "Under Review").order("created_at", { ascending: true }).limit(200);
    const list = data || [];
    if (wide && list.some((r) => r.mine_id)) {
      // Imported contractors may have no mine recorded; a null in an
      // "in" filter makes the whole request fail.
      const ids = [...new Set(list.map((r) => r.mine_id).filter(Boolean))];
      const { data: m } = await supabase.from("mines").select("mine_id, mine_name").in("mine_id", ids);
      const names = Object.fromEntries((m || []).map((x) => [x.mine_id, x.mine_name]));
      list.forEach((r) => { r.mine_name = names[r.mine_id]; });
    }
    setRows(list);
  };
  useEffect(() => { load(); }, [profile?.profile_id]);

  const decide = async (c, status, reviewNote = null) => {
    setBusy(c.contractor_id); setMsg(null);
    const { data, error } = await supabase.from("contractors")
      .update({ status, ...(reviewNote ? { review_note: reviewNote } : {}) })
      .eq("contractor_id", c.contractor_id).select("status");
    setBusy(null);
    if (error) return setMsg({ tone: "error", text: error.message });
    if (!data?.length) return setMsg({ tone: "error", text: "Not saved. You may not have permission for this contractor." });
    setMsg({ tone: "success", text: status === "Active"
      ? `${c.contractor_name} approved and can now be deployed on site.`
      : `${c.contractor_name} not approved. The contractor manager has been told why.` });
    setRejecting(null); setNote("");
    load();
  };

  if (rows && rows.length === 0 && !msg) return null;

  return (
    <Card title="Contractors awaiting approval" severity={rows?.length ? "Pending" : undefined}>
      <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
        A contractor cannot put people on site until approved. Approval needs the safety training
        certificate, workmen compensation insurance, contract labour licence and PF registration on
        record and in date, and must come from someone other than the person who added them.
      </p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {rejecting && (
        <div style={{ background: "var(--primary-wash)", borderLeft: "3px solid var(--primary)",
                      padding: 14, marginBottom: 14, borderRadius: 3 }}>
          <Field label={`Why is ${rejecting.contractor_name} not approved?`}>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Blasting licence not produced; insurance covers 20 workers, crew is 45" />
          </Field>
          <Button disabled={!note.trim() || busy === rejecting.contractor_id}
            onClick={() => decide(rejecting, "Rejected", note.trim())}>Send back to the contractor manager</Button>
          <Button variant="quiet" style={{ marginLeft: 12 }} onClick={() => { setRejecting(null); setNote(""); }}>Cancel</Button>
        </div>
      )}
      <Table
        columns={[
          ...(wide ? [{ key: "mine_name", label: "Mine", width: 150, render: (r) => r.mine_name || "—" }] : []),
          { key: "contractor_name", label: "Contractor", render: (r) => (
              <>
                <strong>{r.contractor_name}</strong>
                <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                  {r.contract_type || "Scope not stated"}
                  {r.contract_start && ` · ${r.contract_start} to ${r.contract_end || "open"}`}
                </div>
              </>
            ) },
          { key: "created_by_name", label: "Added by", width: 150, render: (r) => r.created_by_name || "Imported" },
          { key: "document_gaps", label: "Documents", render: (r) => (r.document_gaps || []).length
              ? <span style={{ color: "var(--sev-high)", fontSize: 13.5 }}>Missing or lapsed: {r.document_gaps.join(", ")}</span>
              : <span style={{ color: "var(--sev-low)" }}>All four in date</span> },
          { key: "act", label: "", width: 210, render: (r) => r.created_by && r.created_by === profile?.profile_id
              ? <span style={{ fontSize: 13, color: "var(--ink-faint)" }}>You added this; someone else approves</span>
              : (
                <>
                  <Button disabled={busy === r.contractor_id || (r.document_gaps || []).length > 0 || r.blacklisted}
                    title={(r.document_gaps || []).length ? "Documents missing or lapsed" : undefined}
                    onClick={() => decide(r, "Active")}>Approve</Button>
                  <Button variant="secondary" style={{ marginLeft: 8 }} disabled={busy === r.contractor_id}
                    onClick={() => { setRejecting(r); setNote(""); }}>Reject</Button>
                </>
              ) },
        ]}
        rows={rows || []}
        countLabel="contractors"
        severityOf={(r) => ((r.document_gaps || []).length ? "High" : "Pending")}
        empty="No contractors are waiting for approval."
      />
    </Card>
  );
}
