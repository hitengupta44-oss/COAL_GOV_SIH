import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";

function ContractorManagerDashboardContent() {
  const { profile, logout } = useAuth();
  const [contractors, setContractors] = useState(null);

  useEffect(() => {
    let query = supabase.from("contractors").select("*").order("contract_end", { ascending: true });
    if (profile.subsidiary_id) query = query.eq("subsidiary_id", profile.subsidiary_id);
    query.then(({ data }) => setContractors(data));
  }, [profile]);

  const toggleBlacklist = async (contractorId, current) => {
    await supabase.from("contractors").update({ blacklisted: !current }).eq("contractor_id", contractorId);
    setContractors((prev) => prev.map((c) => c.contractor_id === contractorId ? { ...c, blacklisted: !current } : c));
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>📋 Contractor Manager Dashboard</h1>
        <button onClick={logout}>Log Out</button>
      </div>

      <section style={{ marginTop: 24 }}>
        <h2>Contractors</h2>
        {contractors?.length ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr><th style={th}>Name</th><th style={th}>Type</th><th style={th}>Contract End</th><th style={th}>Status</th><th style={th}>Blacklisted</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {contractors.map((c) => (
                <tr key={c.contractor_id}>
                  <td style={td}>{c.contractor_name}</td>
                  <td style={td}>{c.contract_type}</td>
                  <td style={td}>{c.contract_end}</td>
                  <td style={td}>{c.status}</td>
                  <td style={td}>{c.blacklisted ? "Yes" : "No"}</td>
                  <td style={td}><button onClick={() => toggleBlacklist(c.contractor_id, c.blacklisted)}>Toggle</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p style={{ color: "#666" }}>No contractors found.</p>}
      </section>
    </div>
  );
}

const th = { textAlign: "left", borderBottom: "2px solid #ddd", padding: 8 };
const td = { borderBottom: "1px solid #eee", padding: 8 };

export default function ContractorManagerDashboard() {
  return (
    <RoleGuard allowedRoles={["contractor_manager"]}>
      <ContractorManagerDashboardContent />
    </RoleGuard>
  );
}
