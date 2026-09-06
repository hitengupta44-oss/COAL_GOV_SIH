import { useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";

function WorkerDashboardContent() {
  const { profile, logout } = useAuth();
  const [category, setCategory] = useState("Wages/Payment Delay");
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const fileGrievance = async () => {
    await supabase.from("grievances").insert({
      mine_id: profile.mine_id,
      subsidiary_id: profile.subsidiary_id,
      filed_by: profile.profile_id,
      date_filed: new Date().toISOString().slice(0, 10),
      category,
      description,
      status: "In Progress",
      is_synthetic: false,
    });
    setSubmitted(true);
    setDescription("");
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 600, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>👷 Worker Dashboard</h1>
        <button onClick={logout}>Log Out</button>
      </div>
      <p>Welcome, {profile.full_name || profile.email}</p>

      <section style={{ marginTop: 24, border: "1px solid #ddd", borderRadius: 8, padding: 20 }}>
        <h2>File a Grievance</h2>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }}>
          {["Wages/Payment Delay", "Safety Equipment Shortage", "Housing/Welfare", "Working Hours", "Harassment/Conduct", "Medical Facility", "Transport"]
            .map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the issue..."
          rows={4}
          style={{ width: "100%", padding: 8, marginBottom: 8 }}
        />
        <button onClick={fileGrievance}>Submit Grievance</button>
        {submitted && <p style={{ color: "green" }}>Grievance filed. You'll be notified when it's reviewed.</p>}
      </section>
    </div>
  );
}

export default function WorkerDashboard() {
  return (
    <RoleGuard allowedRoles={["worker"]}>
      <WorkerDashboardContent />
    </RoleGuard>
  );
}
