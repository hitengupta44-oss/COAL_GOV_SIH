import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import MineMap from "../../components/MineMap";
import AlertsPanel from "../../components/AlertsPanel";
import { Card, StatStrip, Table, Badge, Button, Notice } from "../../components/ui";
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
      .select("contractor_name, document_type, computed_status, valid_until, days_to_expiry")
      .in("computed_status", ["Expired", "Expiring", "Missing"])
      .order("days_to_expiry", { nullsFirst: true })
      .limit(500);
    setDocs(d || []);
  };

  useEffect(() => { load(); }, [profile?.subsidiary_id]);

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
          { label: "Contracts ending within 60 days", value: expiringContracts, tone: expiringContracts ? "medium" : null },
          { label: "Lapsed documents", value: expiredDocs, tone: expiredDocs ? "critical" : null, note: "Blocks work on site" },
          { label: "Blacklisted", value: blacklisted, tone: blacklisted ? "critical" : null },
        ]}
      />

      <AlertsPanel />

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
            { key: "contract_state", label: "Contract", width: 140, nowrap: true },
            { key: "expired_documents", label: "Lapsed docs", width: 110, align: "right",
              render: (c) => c.expired_documents || 0 },
            { key: "act", label: "", width: 130,
              render: (c) => (
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
