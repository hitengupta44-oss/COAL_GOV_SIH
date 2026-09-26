import { useEffect, useState } from "react";
import { Card, Table, Field, Button, Notice, StatStrip } from "./ui";
import { GeoBadge } from "./Evidence";
import { useAuth } from "../lib/useAuth";
import { supabase } from "../lib/supabase";
import { getPosition, isOnline } from "../lib/geo";
import { enqueue } from "../lib/offlineQueue";

// Crew attendance for contract labour.
//
// Contract workers have no accounts on the platform, so their supervisor
// -- the contractor manager or the mine official -- records each crew's
// headcount per shift, geo-tagged at the site. The database refuses a crew
// from a contractor that is not approved or is blacklisted, and flags (and
// alerts the mine about) any crew working while one of the contractor's
// statutory documents has lapsed.

const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const shiftNow = () => {
  const h = new Date(Date.now() + 5.5 * 3600e3).getUTCHours();
  return h >= 6 && h < 14 ? "A" : h >= 14 && h < 22 ? "B" : "C";
};

export default function CrewAttendance() {
  const { profile } = useAuth();
  const [contractors, setContractors] = useState([]);
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ contractor_id: "", shift: shiftNow(), headcount: "", supervisor_name: "", work_area: "" });
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const load = async () => {
    if (!profile?.mine_id) return;
    const { data: c } = await supabase.from("contractor_register_view")
      .select("contractor_id, contractor_name, status, blacklisted, document_gaps")
      .eq("mine_id", profile.mine_id).order("contractor_name");
    setContractors(c || []);
    const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    const { data } = await supabase.from("crew_attendance_view")
      .select("record_id, contractor_name, attendance_date, shift, headcount, supervisor_name, work_area, "
            + "documents_lapsed, lapsed_documents, within_geofence, distance_from_mine_m, recorded_by_name")
      .eq("mine_id", profile.mine_id).gte("attendance_date", since)
      .order("attendance_date", { ascending: false }).limit(500);
    setRows(data || []);
  };
  useEffect(() => { load(); }, [profile?.mine_id]);

  const eligible = contractors.filter((c) => c.status === "Active" && !c.blacklisted);
  const blocked = contractors.filter((c) => !(c.status === "Active" && !c.blacklisted));
  const chosen = contractors.find((c) => c.contractor_id === f.contractor_id);

  const save = async () => {
    if (!f.contractor_id) return setStatus({ tone: "error", text: "Choose the contractor." });
    const n = Number(f.headcount);
    if (!n || n < 1) return setStatus({ tone: "error", text: "Enter how many workers are on this shift." });
    setBusy(true); setStatus({ tone: "info", text: "Getting your location." });
    let pos = null;
    try { pos = await getPosition({ timeout: 8000 }); } catch { /* recorded without a position */ }

    const row = {
      contractor_id: f.contractor_id, attendance_date: todayIST(), shift: f.shift, headcount: n,
      supervisor_name: f.supervisor_name || null, work_area: f.work_area || null,
      latitude: pos?.latitude ?? null, longitude: pos?.longitude ?? null,
    };
    const queue = async () => {
      await enqueue("crew", row, profile?.profile_id);
      setStatus({ tone: "info", text: "Saved on this device. It will be sent when you have a signal." });
      setF({ ...f, headcount: "" });
    };
    try {
      if (!isOnline()) return await queue();
      const { data, error } = await supabase.from("contractor_crew_attendance")
        .upsert(row, { onConflict: "contractor_id,attendance_date,shift" })
        .select("documents_lapsed, lapsed_documents, within_geofence").single();
      if (error) {
        if (/fetch|network/i.test(error.message)) return await queue();
        return setStatus({ tone: "error", text: error.message });
      }
      setStatus(data.documents_lapsed
        ? { tone: "error", text: `Recorded ${n} workers. Warning: this contractor's ${data.lapsed_documents.join(", ")} `
            + "is missing or lapsed, so the mine official has been alerted." }
        : { tone: data.within_geofence === false ? "error" : "success",
            text: `Recorded ${n} workers for shift ${f.shift}.`
              + (data.within_geofence === false ? " Your position is outside the mine's boundary, so it has been flagged." : "") });
      setF({ ...f, headcount: "" });
      load();
    } catch (e) {
      try { await queue(); } catch { setStatus({ tone: "error", text: String(e.message || e) }); }
    } finally {
      setBusy(false);
    }
  };

  const list = rows || [];
  const today = todayIST();
  const todays = list.filter((r) => r.attendance_date === today);
  const lapsedToday = todays.filter((r) => r.documents_lapsed).reduce((s, r) => s + r.headcount, 0);

  return (
    <>
      <StatStrip items={[
        { label: "Contract workers on site today", value: todays.reduce((s, r) => s + r.headcount, 0),
          note: `${new Set(todays.map((r) => r.contractor_name)).size} contractors` },
        { label: "Working under lapsed documents today", value: lapsedToday, tone: lapsedToday ? "critical" : null },
        { label: "Contractors that cannot be deployed", value: blocked.length, tone: blocked.length ? "medium" : null,
          note: "Not approved, contract ended or blacklisted" },
      ]} />

      <Card title="Record crew attendance" style={{ maxWidth: 640 }}>
        <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
          For contract workers who do not sign in themselves. Record each crew once per shift at the site;
          your location is attached.
        </p>
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        <div className="formgrid">
          <Field label="Contractor">
            <select value={f.contractor_id} onChange={set("contractor_id")}>
              <option value="">Choose</option>
              {eligible.map((c) => <option key={c.contractor_id} value={c.contractor_id}>{c.contractor_name}</option>)}
              {blocked.length > 0 && (
                <optgroup label="Cannot be deployed">
                  {blocked.map((c) => (
                    <option key={c.contractor_id} value={c.contractor_id} disabled>
                      {c.contractor_name} ({c.blacklisted ? "blacklisted" : c.status === "Under Review" ? "awaiting approval" : c.status.toLowerCase()})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
          <Field label="Shift">
            <select value={f.shift} onChange={set("shift")}>
              <option value="A">A (06–14)</option><option value="B">B (14–22)</option><option value="C">C (22–06)</option>
            </select>
          </Field>
          <Field label="Workers on this shift"><input type="number" min="1" value={f.headcount} onChange={set("headcount")} /></Field>
          <Field label="Crew supervisor"><input value={f.supervisor_name} onChange={set("supervisor_name")} /></Field>
        </div>
        <Field label="Work area"><input value={f.work_area} onChange={set("work_area")} placeholder="e.g. Bench 3, haul road maintenance" /></Field>
        {chosen && (chosen.document_gaps || []).length > 0 && (
          <Notice tone="error">
            {chosen.contractor_name}&apos;s {chosen.document_gaps.join(", ")} is missing or lapsed.
            You can still record the crew, but the mine official will be alerted.
          </Notice>
        )}
        <Button onClick={save} disabled={busy}>{busy ? "Recording" : "Record crew"}</Button>
      </Card>

      <Card title="Contract labour, last 14 days">
        <Table
          columns={[
            { key: "attendance_date", label: "Date", width: 110, nowrap: true },
            { key: "shift", label: "Shift", width: 60 },
            { key: "contractor_name", label: "Contractor", render: (r) => (
                <>
                  <strong>{r.contractor_name}</strong>
                  {r.work_area && <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{r.work_area}</div>}
                </>
              ) },
            { key: "headcount", label: "Workers", width: 80, align: "right" },
            { key: "docs", label: "Documents", width: 200, render: (r) => r.documents_lapsed
                ? <span style={{ fontSize: 13, color: "var(--sev-critical)" }}>Lapsed: {(r.lapsed_documents || []).join(", ")}</span>
                : <span style={{ fontSize: 13, color: "var(--sev-low)" }}>In date</span> },
            { key: "geo", label: "Recorded", width: 150, render: (r) => <GeoBadge within={r.within_geofence} distance={r.distance_from_mine_m} /> },
            { key: "recorded_by_name", label: "By", width: 140, render: (r) => r.recorded_by_name || r.supervisor_name || "—" },
          ]}
          rows={list}
          countLabel="crew shifts"
          severityOf={(r) => (r.documents_lapsed ? "Critical" : r.within_geofence === false ? "High" : null)}
          empty="No crew attendance recorded in the last 14 days."
        />
      </Card>
    </>
  );
}
