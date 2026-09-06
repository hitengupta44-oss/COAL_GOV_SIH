import { useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import { useAuth } from "../../lib/useAuth";
import { logFieldInspection } from "../../lib/api";
import { supabase } from "../../lib/supabase";

function InspectorDashboardContent() {
  const { profile, logout, getAccessToken } = useAuth();
  const [mineId, setMineId] = useState("");
  const [obsType, setObsType] = useState("Safety Equipment Check");
  const [severity, setSeverity] = useState("Low");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("");

  const submitInspection = async () => {
    if (!navigator.geolocation) {
      setStatus("Geolocation not available on this device.");
      return;
    }
    const accessToken = await getAccessToken();
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const result = await logFieldInspection(accessToken, {
        mineId,
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        observationType: obsType,
        severity,
        notes,
      });
      if (result?.error) {
        setStatus(`Couldn't log inspection: ${result.error}`);
        return;
      }
      setStatus("Inspection logged.");
      setNotes("");
    }, () => setStatus("Location permission denied -- required for geo-tagged inspections."));
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 600, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>🔍 Inspector Dashboard</h1>
        <button onClick={logout}>Log Out</button>
      </div>

      <section style={{ marginTop: 24, border: "1px solid #ddd", borderRadius: 8, padding: 20 }}>
        <h2>Log Field Inspection</h2>
        <input placeholder="Mine ID (UUID)" value={mineId} onChange={(e) => setMineId(e.target.value)}
          style={{ width: "100%", padding: 8, marginBottom: 8 }} />
        <select value={obsType} onChange={(e) => setObsType(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }}>
          {["Safety Equipment Check", "Ventilation Inspection", "Slope Stability", "Electrical Safety", "Housekeeping", "Water Accumulation", "PPE Compliance"]
            .map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ width: "100%", padding: 8, marginBottom: 8 }}>
          {["Low", "Medium", "High", "Critical"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes"
          rows={3} style={{ width: "100%", padding: 8, marginBottom: 8 }} />
        <button onClick={submitInspection}>Submit (captures GPS automatically)</button>
        {status && <p style={{ marginTop: 8 }}>{status}</p>}
      </section>
    </div>
  );
}

export default function InspectorDashboard() {
  return (
    <RoleGuard allowedRoles={["inspector"]}>
      <InspectorDashboardContent />
    </RoleGuard>
  );
}
