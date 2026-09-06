import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import ChatPanel from "../../components/ChatPanel";
import { Card, StatStrip, Table, Badge, Button, Notice } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";

function ContractorContent() {
  const { profile } = useAuth();
  const [contractors, setContractors] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let q = supabase.from("contractors").select("*").order("contract_end", { ascending: true });
    if (profile?.subsidiary_id) q = q.eq("subsidiary_id", profile.subsidiary_id);
    q.then(({ data }) => setContractors(data || []));
  }, [profile?.subsidiary_id]);

  // The write is confirmed against the returned row rather than assumed:
  // a blocked update resolves without throwing, so optimistically flipping
  // the flag would show a change that never reached the database.
  const toggleBlacklist = async (id, current) => {
    setBusyId(id);
    setError(null);
    const { data, error: err } = await supabase
      .from("contractors").update({ blacklisted: !current })
      .eq("contractor_id", id).select();
    setBusyId(null);
    if (err) return setError(`Could not update this contractor: ${err.message}`);
    if (!data?.length) return setError("The change was not saved. You may not have permission to update this contractor.");
    setContractors((prev) => prev.map((c) => (c.contractor_id === id ? { ...c, blacklisted: !current } : c)));
  };

  const list = contractors || [];
  const active = list.filter((c) => c.status === "Active").length;
  const blacklisted = list.filter((c) => c.blacklisted).length;
  const review = list.filter((c) => c.status === "Under Review").length;

  return (
    <Layout title="Contractors" subtitle="">
      {error && <Notice tone="error">{error}</Notice>}

      <StatStrip
        items={[
          { label: "Active contracts", value: active },
          { label: "Under review", value: review, tone: review ? "medium" : null },
          { label: "Blacklisted", value: blacklisted, tone: blacklisted ? "critical" : null },
        ]}
      />

      <Card title="Contract register">
        <Table
          columns={[
            { key: "contractor_name", label: "Contractor",
              render: (r) => <strong>{r.contractor_name}</strong> },
            { key: "contract_type", label: "Scope" },
            { key: "contract_end", label: "Ends", width: 120, nowrap: true },
            { key: "status", label: "Status", width: 130, render: (r) => <Badge>{r.status}</Badge> },
            { key: "blacklisted", label: "Blacklisted", width: 110,
              render: (r) => (r.blacklisted ? <Badge>Critical</Badge> : "No") },
            { key: "act", label: "", width: 130,
              render: (r) => (
                <Button variant="secondary" disabled={busyId === r.contractor_id}
                  onClick={() => toggleBlacklist(r.contractor_id, r.blacklisted)}>
                  {r.blacklisted ? "Remove flag" : "Blacklist"}
                </Button>
              ) },
          ]}
          rows={list}
          severityOf={(r) => (r.blacklisted ? "Critical" : r.status)}
          empty="No contractors on record for your subsidiary."
        />
      </Card>

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
