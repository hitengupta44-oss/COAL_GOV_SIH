import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";

function WorkerDashboardContent() {
  const { profile, logout } = useAuth();
  const [category, setCategory] = useState("Wages/Payment Delay");
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [mine, setMine] = useState(null);
  const [myGrievances, setMyGrievances] = useState([]);

  // Shows the worker their own filed grievances, so a submission visibly
  // lands instead of relying on a message that says it did.
  const loadMine = async () => {
    if (!profile?.profile_id) return;
    const { data } = await supabase
      .from("grievances")
      .select("category, description, status, date_filed")
      .eq("filed_by", profile.profile_id)
      .order("date_filed", { ascending: false })
      .limit(5);
    setMyGrievances(data || []);
  };

  useEffect(() => {
    loadMine();
  }, [profile?.profile_id]);

  // BUG FIX: the insert result used to be discarded and setSubmitted(true)
  // ran unconditionally, so the green "Grievance filed" message appeared
  // even when the row was rejected -- the failure was completely invisible
  // both to the worker and to anyone testing. supabase-js does NOT throw on
  // a failed insert; it resolves with an { error } object, so the error has
  // to be checked explicitly.
  const fileGrievance = async () => {
    setError(null);
    if (!description.trim()) {
      setError("Please describe the issue before submitting.");
      return;
    }
    if (!profile?.mine_id) {
      setError("No mine assigned to your account -- ask an admin to set one.");
      return;
    }

    setSaving(true);
    const { data, error: insertError } = await supabase
      .from("grievances")
      .insert({
        mine_id: profile.mine_id,
        subsidiary_id: profile.subsidiary_id ?? null,
        filed_by: profile.profile_id,
        date_filed: new Date().toISOString().slice(0, 10),
        category,
        description,
        status: "In Progress",
        is_synthetic: false,
      })
      .select();
    setSaving(false);

    if (insertError) {
      setError(`Could not file grievance: ${insertError.message}`);
      return;
    }
    if (!data || data.length === 0) {
      setError(
        "The insert returned no row. This usually means a row-level security policy blocked it."
      );
      return;
    }
    setSubmitted(true);
    setDescription("");
    loadMine();
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 600, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>👷 Worker Dashboard</h1>
        <button onClick={logout}>Log Out</button>
      </div>
      <p>Welcome, {profile?.full_name || profile?.email}</p>

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
        <button onClick={fileGrievance} disabled={saving}>
          {saving ? "Submitting..." : "Submit Grievance"}
        </button>
        {error && (
          <p style={{ color: "#b00", background: "#fee", padding: 10, borderRadius: 6 }}>{error}</p>
        )}
        {submitted && !error && (
          <p style={{ color: "green" }}>Grievance filed. You&apos;ll be notified when it&apos;s reviewed.</p>
        )}
      </section>

      <section style={{ marginTop: 28 }}>
        <h2>My Grievances</h2>
        {myGrievances.length === 0 ? (
          <p style={{ color: "#666" }}>You haven&apos;t filed any yet.</p>
        ) : (
          <ul>
            {myGrievances.map((g, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                <strong>{g.category}</strong> — {g.status} ({g.date_filed})
                <div style={{ color: "#555" }}>{g.description}</div>
              </li>
            ))}
          </ul>
        )}
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
