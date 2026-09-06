import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import { useAuth } from "../../lib/useAuth";
import { logFieldInspection } from "../../lib/api";
import { supabase } from "../../lib/supabase";

function InspectorDashboardContent() {
  const { profile, logout, getAccessToken } = useAuth();
  const [mineName, setMineName] = useState("");
  const [obsType, setObsType] = useState("Safety Equipment Check");
  const [severity, setSeverity] = useState("Low");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [recent, setRecent] = useState([]);

  // The mine is no longer typed in by hand. It used to be a free-text
  // "Mine ID (UUID)" box, which was unusable in practice -- nobody can
  // recall a UUID, and the backend rejects any mine other than the
  // inspector's own anyway (see log_field_inspection's _require_own_mine
  // check), so that field could only ever produce the right answer or an
  // error. We read the assigned mine off the profile and show its name.
  useEffect(() => {
    if (!profile?.mine_id) return;
    supabase
      .from("mines")
      .select("mine_name, state, district")
      .eq("mine_id", profile.mine_id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setMineName([data.mine_name, data.district, data.state].filter(Boolean).join(", "));
        }
      });
  }, [profile?.mine_id]);

  const loadRecent = async () => {
    if (!profile?.mine_id) return;
    const { data } = await supabase
      .from("geo_inspections")
      .select("observation_type, severity, notes, timestamp, latitude, longitude")
      .eq("mine_id", profile.mine_id)
      .order("timestamp", { ascending: false })
      .limit(8);
    setRecent(data || []);
  };

  useEffect(() => {
    loadRecent();
  }, [profile?.mine_id]);

  const submitInspection = async () => {
    if (!profile?.mine_id) {
      setStatus("No mine assigned to your account -- ask an admin to set one.");
      return;
    }
    if (!navigator.geolocation) {
      setStatus("Geolocation not available on this device.");
      return;
    }

    setSubmitting(true);
    setStatus("Getting your location...");
    const accessToken = await getAccessToken();

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          setStatus("Submitting...");
          const result = await logFieldInspection(accessToken, {
            mineId: profile.mine_id,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            observationType: obsType,
            severity,
            notes,
          });
          if (result?.error) {
            setStatus(`Couldn't log inspection: ${result.error}`);
          } else {
            setStatus(
              `Inspection logged at ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`
            );
            setNotes("");
            loadRecent();
          }
        } catch (e) {
          setStatus(`Couldn't log inspection: ${e.message || e}`);
        } finally {
          setSubmitting(false);
        }
      },
      () => {
        setStatus("Location permission denied -- required for geo-tagged inspections.");
        setSubmitting(false);
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 700, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>🔍 Inspector Dashboard</h1>
        <button onClick={logout}>Log Out</button>
      </div>
      <p>{profile?.full_name || profile?.email} — Field Inspector</p>

      <section style={{ marginTop: 24, border: "1px solid #ddd", borderRadius: 8, padding: 20 }}>
        <h2 style={{ marginTop: 0 }}>Log Field Inspection</h2>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: "#666" }}>Mine</div>
          <div style={{ fontWeight: 600 }}>
            {mineName || (profile?.mine_id ? "Loading..." : "No mine assigned")}
          </div>
        </div>

        <label style={lbl}>Observation type</label>
        <select value={obsType} onChange={(e) => setObsType(e.target.value)} style={fld}>
          {["Safety Equipment Check", "Ventilation Inspection", "Slope Stability",
            "Electrical Safety", "Housekeeping", "Water Accumulation", "PPE Compliance"]
            .map((o) => <option key={o} value={o}>{o}</option>)}
        </select>

        <label style={lbl}>Severity</label>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={fld}>
          {["Low", "Medium", "High", "Critical"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <label style={lbl}>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="What did you observe?" rows={3} style={fld} />

        <button onClick={submitInspection} disabled={submitting} style={{ padding: "8px 16px" }}>
          {submitting ? "Submitting..." : "Submit (captures GPS automatically)"}
        </button>
        {status && <p style={{ marginTop: 10 }}>{status}</p>}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Recent Inspections at This Mine</h2>
        {recent.length === 0 ? (
          <p style={{ color: "#666" }}>None logged yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Type</th>
                <th style={th}>Severity</th>
                <th style={th}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={i}>
                  <td style={td}>{r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}</td>
                  <td style={td}>{r.observation_type}</td>
                  <td style={td}>{r.severity}</td>
                  <td style={td}>{r.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const lbl = { display: "block", fontSize: 13, color: "#666", marginBottom: 4 };
const fld = { width: "100%", padding: 8, marginBottom: 12 };
const th = { textAlign: "left", borderBottom: "2px solid #ddd", padding: 8 };
const td = { borderBottom: "1px solid #eee", padding: 8 };

export default function InspectorDashboard() {
  return (
    <RoleGuard allowedRoles={["inspector"]}>
      <InspectorDashboardContent />
    </RoleGuard>
  );
}
