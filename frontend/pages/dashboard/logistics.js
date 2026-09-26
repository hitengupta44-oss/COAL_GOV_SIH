import { useEffect, useMemo, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import { Card, StatStrip, Table, Badge, Field, Button, Notice } from "../../components/ui";
import { PhotoInput, EvidenceLink, GeoBadge } from "../../components/Evidence";
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";
import { uploadEvidence, evidenceUrl } from "../../lib/evidence";
import { getPosition } from "../../lib/geo";
import { screenCoalPhotos } from "../../lib/api";
import { loadPdf } from "../../lib/pdf";

// Dispatch and coal grade verification (migration 15).
//
// The mine records each dispatch with its DECLARED grade. At the siding or
// weighbridge an inspector photographs the load and records the grade test
// (GCV, ash, moisture). The database works out the ACTUAL grade from GCV
// using the Coal Controller's bands and compares the two. The photos are
// also screened by an AI vision model for visible warning signs -- but a
// photo cannot measure GCV, so on its own it can only ask for a lab test.

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const fmt = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const num = (v) => (v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 }));
const MODES = ["Rail", "Road", "Conveyor / MGR"];
const METHODS = ["Field test", "Laboratory (third party)", "Laboratory (mine)"];

function gradeFor(bands, gcv) {
  if (gcv == null || gcv === "" || Number.isNaN(Number(gcv))) return null;
  const g = Number(gcv);
  if (g < 2201) return { grade: "Ungraded", rank: 18 };
  return bands.find((b) => g >= b.gcv_min && (b.gcv_max == null || g <= b.gcv_max)) || null;
}
const bandText = (b) => (b ? `${b.gcv_min.toLocaleString()}${b.gcv_max ? `–${b.gcv_max.toLocaleString()}` : "+"} kcal/kg` : "");

// ------------------------------------------------------------------
// Mine official: record a dispatch
// ------------------------------------------------------------------
function DispatchEntry({ mineId, bands, official, points, onSaved }) {
  const blank = { dispatch_date: today(), mode: "Rail", vehicle_ref: "", consignee: "", quantity_t: "",
                  declared_grade: official?.grade || "", dispatch_point: "", remarks: "" };
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { if (official?.grade && !f.declared_grade) setF((x) => ({ ...x, declared_grade: official.grade })); }, [official?.grade]);
  const rank = (g) => bands.find((b) => b.grade === g)?.rank;
  const above = official?.grade && f.declared_grade && rank(f.declared_grade) < rank(official.grade);
  const pickPoint = (e) => {
    const pt = points.find((p) => String(p.declared_grade_id) === e.target.value);
    setF({ ...f, dispatch_point: pt ? `${pt.dispatch_point}${pt.location ? ` (${pt.location})` : ""}` : "",
           declared_grade: pt ? pt.grade : f.declared_grade });
  };

  const save = async () => {
    if (!f.vehicle_ref.trim() || !f.consignee.trim() || !Number(f.quantity_t) || !f.declared_grade) {
      return setMsg({ tone: "error", text: "Fill in the rake or vehicle, consignee, tonnes and declared grade." });
    }
    setBusy(true); setMsg(null);
    const { error } = await supabase.from("coal_dispatches").insert({
      mine_id: mineId, dispatch_date: f.dispatch_date, mode: f.mode, vehicle_ref: f.vehicle_ref.trim(),
      consignee: f.consignee.trim(), quantity_t: Number(f.quantity_t), declared_grade: f.declared_grade,
      remarks: f.remarks.trim() || null, dispatch_point: f.dispatch_point || null,
    });
    setBusy(false);
    if (error) return setMsg({ tone: "error", text: error.message });
    setMsg({ tone: "success", text: `Dispatch ${f.vehicle_ref} recorded as ${f.declared_grade}. It cannot be changed from here on.` });
    setF({ ...blank, dispatch_date: f.dispatch_date, mode: f.mode, consignee: f.consignee });
    onSaved();
  };

  return (
    <Card title="Record a dispatch">
      <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
        The declared grade is what the customer is billed for. Once recorded it cannot be edited.
        {official?.grade && <> This mine&apos;s official grade for {official.fy} is <strong>{official.grade}</strong>
          {official.provisional ? " (provisional)" : ""}.</>}
      </p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="formgrid">
        <Field label="Date"><input type="date" max={today()} value={f.dispatch_date} onChange={set("dispatch_date")} /></Field>
        <Field label="Mode">
          <select value={f.mode} onChange={set("mode")}>{MODES.map((m) => <option key={m}>{m}</option>)}</select>
        </Field>
        <Field label={f.mode === "Rail" ? "Rake number" : f.mode === "Road" ? "Truck registration" : "Belt / MGR reference"}>
          <input value={f.vehicle_ref} onChange={set("vehicle_ref")} placeholder={f.mode === "Rail" ? "e.g. RK-2409-117" : "e.g. JH02AB1234"} />
        </Field>
        <Field label="Consignee"><input value={f.consignee} onChange={set("consignee")} placeholder="e.g. NTPC Korba" /></Field>
        {points.length > 0 && (
          <Field label="Dispatch point (official list)">
            <select onChange={pickPoint} defaultValue="">
              <option value="">Not specified</option>
              {points.map((p) => (
                <option key={p.declared_grade_id} value={p.declared_grade_id}>
                  {p.dispatch_point}{p.location ? ` (${p.location})` : ""} · {p.grade}{p.provisional ? " (P)" : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Quantity (t)"><input type="number" min="1" value={f.quantity_t} onChange={set("quantity_t")} /></Field>
        <Field label="Declared grade">
          <select value={f.declared_grade} onChange={set("declared_grade")}>
            <option value="">Choose</option>
            {bands.map((b) => <option key={b.grade} value={b.grade}>{b.grade} · {bandText(b)}</option>)}
          </select>
        </Field>
      </div>
      {above && (
        <Notice tone="error">
          {f.declared_grade} is better than this mine&apos;s official grade {official.grade}. If recorded, corporate is alerted
          that the dispatch is billed above the official grade.
        </Notice>
      )}
      <Field label="Remarks (optional)"><input value={f.remarks} onChange={set("remarks")} /></Field>
      <Button onClick={save} disabled={busy}>{busy ? "Saving" : "Record dispatch"}</Button>
    </Card>
  );
}

// ------------------------------------------------------------------
// Inspector: check a dispatch
// ------------------------------------------------------------------
function GradeCheckForm({ dispatches, bands, getAccessToken, onSaved }) {
  const blank = { dispatch_id: "", test_method: "", sample_ref: "", gcv: "", ash: "", moisture: "", notes: "" };
  const [f, setF] = useState(blank);
  const [photos, setPhotos] = useState([null, null, null]);
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const d = dispatches.find((x) => x.dispatch_id === f.dispatch_id);
  const declared = bands.find((b) => b.grade === d?.declared_grade);
  const tested = gradeFor(bands, f.gcv);
  const gap = tested && declared ? tested.rank - declared.rank : null;

  const submit = async () => {
    if (!d) return setStatus({ tone: "error", text: "Choose the dispatch you are checking." });
    const files = photos.filter(Boolean);
    if (!files.length) return setStatus({ tone: "error", text: "Add at least one photo of the load." });
    if (f.gcv && !f.test_method) return setStatus({ tone: "error", text: "Say how the GCV was measured." });
    setBusy(true); setResult(null);
    try {
      setStatus({ tone: "info", text: "Getting your location and uploading photos." });
      let pos = null;
      try { pos = await getPosition({ timeout: 8000 }); } catch { /* recorded without a position */ }
      const paths = [];
      for (const file of files) paths.push(await uploadEvidence(d.mine_id, "grade-checks", file));
      const { data, error } = await supabase.from("grade_checks").insert({
        dispatch_id: d.dispatch_id, photo_paths: paths,
        latitude: pos?.latitude ?? null, longitude: pos?.longitude ?? null,
        test_method: f.test_method || null, sample_ref: f.sample_ref.trim() || null,
        gcv_kcal_kg: f.gcv ? Number(f.gcv) : null, ash_pct: f.ash ? Number(f.ash) : null,
        moisture_pct: f.moisture ? Number(f.moisture) : null, notes: f.notes.trim() || null,
      }).select("check_id, verdict, assessed_grade, grade_gap").single();
      if (error) throw new Error(error.message);

      setStatus({ tone: "info", text: "Saved. Screening the photos (this takes a few seconds)." });
      let screening = null;
      try {
        screening = await screenCoalPhotos(await getAccessToken(), data.check_id);
      } catch (e) {
        screening = { error: String(e.message || e) };
      }
      setResult({ ...data, verdict: screening?.verdict || data.verdict, screening });
      setStatus(null);
      setF(blank); setPhotos([null, null, null]);
      onSaved(data.check_id);
    } catch (e) {
      setStatus({ tone: "error", text: String(e.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const recent = dispatches.filter((x) => x.dispatch_date >= daysAgo(60));

  return (
    <Card title="Check a dispatch">
      <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
        Photograph the load and record the grade test. Grade is decided by GCV from the test; the photos are
        screened for visible warning signs (stones, shale, fines, wet coal) but cannot prove a grade on their own.
      </p>
      {status && <Notice tone={status.tone}>{status.text}</Notice>}
      {result && <ResultNotice result={result} />}
      <Field label="Dispatch">
        <select value={f.dispatch_id} onChange={set("dispatch_id")}>
          <option value="">Choose</option>
          {recent.map((x) => (
            <option key={x.dispatch_id} value={x.dispatch_id}>
              {x.dispatch_date} · {x.mode} {x.vehicle_ref} → {x.consignee} · {num(x.quantity_t)} t · declared {x.declared_grade}
              {x.checks ? ` · checked ${x.checks}×` : ""}
            </option>
          ))}
        </select>
      </Field>
      {declared && (
        <p style={{ fontSize: 13.5, color: "var(--ink-soft)", margin: "-4px 0 12px" }}>
          Declared {declared.grade}: {bandText(declared)}.
          {d.official_grade && <> Official grade of the mine ({d.official_fy}): {d.official_grade}.</>}
          {d.declared_above_official && <strong style={{ color: "var(--sev-critical)" }}> Declared above the official grade.</strong>}
        </p>
      )}
      <div className="formgrid">
        <PhotoInput value={photos[0]} onChange={(v) => setPhotos([v, photos[1], photos[2]])} label="Photo 1: the load from above (required)" />
        <PhotoInput value={photos[1]} onChange={(v) => setPhotos([photos[0], v, photos[2]])} label="Photo 2: close-up of lumps" />
        <PhotoInput value={photos[2]} onChange={(v) => setPhotos([photos[0], photos[1], v])} label="Photo 3: the sample taken" />
      </div>
      <div className="formgrid">
        <Field label="Test">
          <select value={f.test_method} onChange={set("test_method")}>
            <option value="">No test yet: photo screening only</option>
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="Sample reference"><input value={f.sample_ref} onChange={set("sample_ref")} placeholder="e.g. S/2409/117-A" /></Field>
        <Field label="GCV (kcal/kg)"><input type="number" min="1000" max="8500" value={f.gcv} onChange={set("gcv")} disabled={!f.test_method} /></Field>
        <Field label="Ash (%)"><input type="number" min="0" max="80" step="0.1" value={f.ash} onChange={set("ash")} disabled={!f.test_method} /></Field>
        <Field label="Moisture (%)"><input type="number" min="0" max="60" step="0.1" value={f.moisture} onChange={set("moisture")} disabled={!f.test_method} /></Field>
      </div>
      {tested && declared && (
        <Notice tone={gap > 0 ? "error" : "success"}>
          {Number(f.gcv).toLocaleString()} kcal/kg is <strong>{tested.grade}</strong>{tested.gcv_min ? ` (${bandText(tested)})` : ""}.{" "}
          {gap > 0 ? `That is ${gap} grade${gap > 1 ? "s" : ""} below the declared ${declared.grade}.`
            : gap < 0 ? `That is better than the declared ${declared.grade}.` : `That matches the declared ${declared.grade}.`}
        </Notice>
      )}
      <Field label="Notes (optional)"><textarea rows={2} value={f.notes} onChange={set("notes")} placeholder="e.g. Shale bands visible in wagons 12–18" /></Field>
      <Button onClick={submit} disabled={busy}>{busy ? "Recording" : "Record grade check"}</Button>
    </Card>
  );
}

function ResultNotice({ result }) {
  const s = result.screening || {};
  const a = s.assessment;
  const tone = result.verdict === "Grade slippage" || result.verdict === "Lab test needed" ? "error" : "success";
  return (
    <Notice tone={tone}>
      <strong>Recorded: {result.verdict}.</strong>
      {a && <> AI photo screening: {a.summary} (confidence {a.confidence}).</>}
      {s.error && <> Photo screening was not available: {s.error} The check is saved and stands on its test result.</>}
    </Notice>
  );
}

// ------------------------------------------------------------------
// One check in full, with the mine's answer and the report
// ------------------------------------------------------------------
const AI_ROWS = [
  ["is_coal_load", "Coal load in photo"], ["stone_shale", "Stone / shale"], ["fines", "Fines"],
  ["surface_moisture", "Surface moisture"], ["lustre", "Lustre"], ["consistent_with_declared", "Consistent with declared grade"],
  ["estimated_grade_range", "Visual estimate"], ["confidence", "Confidence"],
];

function CheckDetail({ check, role, mineId, getAccessToken, onClose, onChanged }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const a = check.ai_assessment;
  const canAnswer = role === "mine_official" && check.mine_id === mineId && check.status === "Open";
  const canClose = ["corporate_admin", "admin"].includes(role) && check.status !== "Closed";
  const canScreen = !a && ["inspector", "corporate_admin", "admin"].includes(role);

  const update = async (patch) => {
    setBusy(true); setMsg(null);
    const { error } = await supabase.from("grade_checks").update(patch).eq("check_id", check.check_id);
    setBusy(false);
    if (error) return setMsg({ tone: "error", text: error.message });
    onChanged();
  };
  const screen = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await screenCoalPhotos(await getAccessToken(), check.check_id);
      if (r?.error) setMsg({ tone: "error", text: r.error }); else onChanged();
    } catch (e) { setMsg({ tone: "error", text: String(e.message || e) }); }
    setBusy(false);
  };

  return (
    <Card title={`Grade check · ${check.vehicle_ref}`} severity={check.verdict}
      action={<Button variant="quiet" onClick={onClose}>Close</Button>}>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="formgrid" style={{ fontSize: 14, marginBottom: 8 }}>
        <div><strong>Dispatch</strong><br />{check.dispatch_date} · {check.mode} {check.vehicle_ref}<br />to {check.consignee} · {num(check.quantity_t)} t</div>
        <div><strong>Declared</strong><br />{check.declared_grade}</div>
        <div><strong>Tested</strong><br />{check.gcv_kcal_kg ? `${check.gcv_kcal_kg.toLocaleString()} kcal/kg → ${check.assessed_grade}` : "No test result"}
          {check.ash_pct != null && <><br />Ash {check.ash_pct}% · Moisture {check.moisture_pct ?? "—"}%</>}
          {check.test_method && <><br /><span style={{ color: "var(--ink-soft)" }}>{check.test_method}{check.sample_ref ? ` · ${check.sample_ref}` : ""}</span></>}
        </div>
        <div><strong>Verdict</strong><br /><Badge>{check.verdict}</Badge>
          {check.grade_gap > 0 && <div style={{ fontSize: 13, color: "var(--sev-critical)" }}>{check.grade_gap} grade{check.grade_gap > 1 ? "s" : ""} below declared</div>}
        </div>
      </div>
      <p style={{ fontSize: 14 }}>
        Checked by {check.inspector_name || "—"} on {fmt(check.checked_at)} · <GeoBadge within={check.within_geofence} distance={check.distance_from_mine_m} />
        {" · "}Photos: {(check.photo_paths || []).map((p, i) => (
          <span key={p} style={{ marginRight: 8 }}><EvidenceLink path={p}>{`Photo ${i + 1}`}</EvidenceLink></span>
        ))}
      </p>
      {check.notes && <p style={{ fontSize: 14 }}><strong>Inspector&apos;s notes:</strong> {check.notes}</p>}

      <h3 style={{ fontSize: 15, margin: "14px 0 6px" }}>AI photo screening</h3>
      {a ? (
        <>
          <p style={{ fontSize: 14, margin: "0 0 8px" }}>{a.summary}</p>
          <Table
            columns={[{ key: "k", label: "Sign", width: 240 }, { key: "v", label: "Seen" }]}
            rows={AI_ROWS.filter(([k]) => a[k] != null).map(([k, label]) => ({ k: label, v: String(a[k]) }))
              .concat(a.foreign_material?.length ? [{ k: "Foreign material", v: a.foreign_material.join(", ") }] : [])}
            countLabel="signs"
          />
          <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: "6px 0 0" }}>
            Screened by {check.ai_model} on {fmt(check.ai_at)}. Visual screening only: it cannot measure GCV and does not decide the grade.
          </p>
        </>
      ) : (
        <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>
          Not screened yet.{canScreen && <> <Button variant="secondary" disabled={busy} onClick={screen}>Screen the photos</Button></>}
        </p>
      )}

      <h3 style={{ fontSize: 15, margin: "16px 0 6px" }}>The mine&apos;s answer</h3>
      {check.mine_response ? (
        <p style={{ fontSize: 14 }}><Badge>{check.mine_answer === "Accepted" ? "Accepted by mine" : "Disputed by mine"}</Badge>{" "}
          {check.mine_response}<span style={{ color: "var(--ink-faint)" }}> · {check.responded_by_name}, {fmt(check.responded_at)}</span></p>
      ) : canAnswer ? (
        <>
          <Field label="Response (required)">
            <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="What was found and done, or why the finding is disputed (e.g. referee sample sent to CIMFR)" />
          </Field>
          <Button disabled={busy || !text.trim()} onClick={() => update({ status: "Accepted by mine", mine_response: text.trim() })}>Accept the finding</Button>
          <Button variant="secondary" style={{ marginLeft: 8 }} disabled={busy || !text.trim()}
            onClick={() => update({ status: "Disputed by mine", mine_response: text.trim() })}>Dispute it</Button>
        </>
      ) : (
        <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>Awaiting the mine&apos;s response.</p>
      )}
      {check.status === "Closed" && <p style={{ fontSize: 13.5, color: "var(--ink-soft)" }}>Closed by {check.closed_by_name} on {fmt(check.closed_at)}.</p>}

      <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button variant="secondary" onClick={() => downloadReport(check).catch((e) => setMsg({ tone: "error", text: e.message }))}>
          Download report (PDF)
        </Button>
        {canClose && <Button variant="secondary" disabled={busy} onClick={() => update({ status: "Closed" })}>Close this check</Button>}
      </div>
      <p style={{ fontSize: 12, color: "var(--ink-faint)", wordBreak: "break-all", margin: "10px 0 0" }}>
        Report fingerprint (SHA-256): {check.report_hash}
      </p>
    </Card>
  );
}

// A stored photo as a data URL jsPDF can embed, with its real format (read
// from the file's first bytes, not trusted from the server's content type)
// and its pixel size, so it can be scaled without distortion.
async function photoForPdf(path) {
  const url = await evidenceUrl(path);
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const fmt = buf[0] === 0x89 && buf[1] === 0x50 ? "PNG" : buf[0] === 0xff && buf[1] === 0xd8 ? "JPEG" : null;
  if (!fmt) throw new Error("not an image");
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const data = `data:image/${fmt.toLowerCase()};base64,${btoa(bin)}`;
  const size = await new Promise((resolve, reject) => {
    const im = new Image(); im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = reject; im.src = data;
  });
  return { data, fmt, ...size };
}

// jsPDF's standard fonts cover Latin-1 only; keep report text inside it.
const pdfText = (s) => String(s ?? "").replace(/→/g, "to").replace(/·/g, "|").replace(/[–—]/g, "-").replace(/[‘’]/g, "'");

async function downloadReport(c) {
  const JsPDF = await loadPdf();
  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  doc.setFontSize(16); doc.text("Coal grade verification report", 40, 50);
  doc.setFontSize(10); doc.setTextColor(90);
  doc.text(pdfText(`${c.mine_name}, ${c.state} · generated ${new Date().toLocaleString()}`), 40, 66);
  doc.setTextColor(0);
  doc.autoTable({
    startY: 80, theme: "grid", styles: { fontSize: 9.5 }, headStyles: { fillColor: [22, 33, 43] },
    head: [["Item", "Detail"]],
    body: ([
      ["Dispatch", `${c.dispatch_date} · ${c.mode} ${c.vehicle_ref} → ${c.consignee} · ${num(c.quantity_t)} t`],
      ["Declared grade", c.declared_grade],
      ["Test", c.gcv_kcal_kg ? `${c.test_method}${c.sample_ref ? ` · sample ${c.sample_ref}` : ""}` : "No test result (photo screening only)"],
      ["GCV / ash / moisture", c.gcv_kcal_kg ? `${c.gcv_kcal_kg} kcal/kg · ash ${c.ash_pct ?? "—"}% · moisture ${c.moisture_pct ?? "—"}%` : "—"],
      ["Grade from GCV", c.assessed_grade || "—"],
      ["Verdict", c.verdict + (c.grade_gap > 0 ? ` (${c.grade_gap} grade${c.grade_gap > 1 ? "s" : ""} below declared)` : "")],
      ["AI photo screening", c.ai_assessment ? `${c.ai_assessment.summary} Stone/shale: ${c.ai_assessment.stone_shale}; fines: ${c.ai_assessment.fines}; moisture: ${c.ai_assessment.surface_moisture}; lustre: ${c.ai_assessment.lustre}; consistent: ${c.ai_assessment.consistent_with_declared} (confidence ${c.ai_assessment.confidence}). Model ${c.ai_model}.` : "Not screened"],
      ["Checked by", `${c.inspector_name || "—"} · ${fmt(c.checked_at)} · ${c.within_geofence == null ? "no location" : c.within_geofence ? "at the mine" : "outside the mine boundary"}`],
      ["Inspector's notes", c.notes || "—"],
      ["Mine's answer", c.mine_response ? `${c.mine_answer === "Accepted" ? "Accepted" : "Disputed"}: ${c.mine_response} (${c.responded_by_name}, ${fmt(c.responded_at)})` : "Awaiting response"],
      ["Status", c.status + (c.closed_at ? ` · closed ${fmt(c.closed_at)} by ${c.closed_by_name}` : "")],
    ]).map((row) => row.map(pdfText)),
    columnStyles: { 0: { cellWidth: 130, fontStyle: "bold" } },
  });
  let y = doc.lastAutoTable.finalY + 18;
  doc.setFontSize(9); doc.setTextColor(90);
  doc.text("Grade is determined by GCV under the Coal Controller's grade bands. AI screening of photos is advisory only.", 40, y);
  y += 14;
  doc.text(doc.splitTextToSize(`Report fingerprint (SHA-256): ${c.report_hash}`, W - 80), 40, y);
  doc.setTextColor(0);
  y += 28;
  const paths = (c.photo_paths || []).slice(0, 3);
  if (paths.length) { doc.setFontSize(10); doc.text("Photos of the load", 40, y); y += 10; }
  let x = 40;
  for (const p of paths) {
    try {
      const img = await photoForPdf(p);
      const scale = Math.min(165 / img.w, 125 / img.h);
      doc.addImage(img.data, img.fmt, x, y, img.w * scale, img.h * scale);
      x += 175;
    } catch { /* a photo that cannot be fetched is left out, not faked */ }
  }
  doc.save(`grade-check-${c.vehicle_ref}-${c.dispatch_date}.pdf`);
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------
function LogisticsContent() {
  const { profile, getAccessToken } = useAuth();
  const role = profile?.role;
  const wide = ["corporate_admin", "regulator", "admin"].includes(role);
  const [bands, setBands] = useState([]);
  const [dispatches, setDispatches] = useState(null);
  const [checks, setChecks] = useState(null);
  const [byMine, setByMine] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [official, setOfficial] = useState(null);
  const [declaredList, setDeclaredList] = useState([]);

  useEffect(() => {
    supabase.from("coal_grade_bands").select("*").order("rank").then(({ data }) => setBands(data || []));
    // Official annual grade declarations (e.g. MCL 2025-26). A mine-level
    // user sees the dispatch points of their own area; oversight sees all.
    (async () => {
      let og = null;
      if (profile?.mine_id) {
        const { data } = await supabase.rpc("official_grade_of", { p_mine: profile.mine_id });
        og = (data || [])[0] || null;
        setOfficial(og);
      }
      const { data: rows } = await supabase.from("declared_grade_view").select("*")
        .order("subsidiary").order("declared_grade_id");
      const all = rows || [];
      if (profile?.mine_id && !wide) {
        const areas = new Set(all.filter((r) => (r.mine_ids || []).includes(profile.mine_id)).map((r) => `${r.subsidiary}|${r.area}`));
        setDeclaredList(all.filter((r) => areas.has(`${r.subsidiary}|${r.area}`)));
      } else {
        setDeclaredList(all);
      }
    })();
  }, [profile?.mine_id]);

  const load = async () => {
    const [{ data: d }, { data: c }] = await Promise.all([
      supabase.from("dispatch_view").select("*").order("dispatch_date", { ascending: false }).limit(400),
      supabase.from("grade_check_view").select("*").order("checked_at", { ascending: false }).limit(400),
    ]);
    setDispatches(d || []);
    setChecks(c || []);
    if (wide) {
      const { data: m } = await supabase.from("grade_slippage_by_mine").select("*")
        .order("tonnes_slipped", { ascending: false }).limit(200);
      setByMine(m || []);
    }
  };
  useEffect(() => { load(); }, [profile?.profile_id]);

  const list = checks || [];
  const recentD = (dispatches || []).filter((x) => x.dispatch_date >= daysAgo(30));
  const slip = list.filter((x) => x.verdict === "Grade slippage");
  const tonnesSlipped = slip.reduce((s, x) => s + Number(x.quantity_t || 0), 0);
  const open = useMemo(() => list.find((x) => x.check_id === openId), [list, openId]);
  const aboveOfficial = recentD.filter((x) => x.declared_above_official);

  return (
    <Layout title="Dispatch & coal grade" subtitle={wide ? "All mines" : ""}>
      <StatStrip items={[
        { label: "Dispatches, last 30 days", value: recentD.length,
          note: `${num(recentD.reduce((s, x) => s + Number(x.quantity_t || 0), 0))} t` },
        { label: "Grade checks", value: list.length,
          note: `${list.filter((x) => x.gcv_kcal_kg != null).length} with a test result` },
        { label: "Grade slippage found", value: slip.length, tone: slip.length ? "critical" : null,
          note: slip.length ? `${num(tonnesSlipped)} t below the declared grade` : undefined },
        { label: "Awaiting a lab test", value: list.filter((x) => x.verdict === "Lab test needed").length,
          tone: list.some((x) => x.verdict === "Lab test needed") ? "high" : null },
        (wide || recentD.some((x) => x.official_grade))
          ? { label: "Declared above official grade", value: aboveOfficial.length, tone: aboveOfficial.length ? "high" : null,
              note: "Last 30 days, against the annual declaration" }
          : { label: "Declared above official grade", value: "–",
              note: "No official grade declaration loaded for this mine" },
      ]} />

      {open && (
        <CheckDetail check={open} role={role} mineId={profile?.mine_id} getAccessToken={getAccessToken}
          onClose={() => setOpenId(null)} onChanged={load} />
      )}

      {role === "mine_official" && profile?.mine_id && (
        <DispatchEntry mineId={profile.mine_id} bands={bands} official={official} points={declaredList} onSaved={load} />
      )}
      {role === "inspector" && (
        <GradeCheckForm dispatches={dispatches || []} bands={bands} getAccessToken={getAccessToken}
          onSaved={(id) => { load(); setOpenId(id); }} />
      )}

      {wide && (
        <Card title="Grade slippage by mine" severity={byMine.some((m) => m.slippage_checks > 0) ? "High" : undefined}>
          <Table
            columns={[
              { key: "mine_name", label: "Mine", render: (m) => <><strong>{m.mine_name}</strong><div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{m.state}</div></> },
              { key: "checks", label: "Checks", align: "right", width: 80 },
              { key: "slippage_checks", label: "Slippage", align: "right", width: 90 },
              { key: "tonnes_slipped", label: "Tonnes below grade", align: "right", width: 150, render: (m) => num(m.tonnes_slipped) },
              { key: "avg_grades_below", label: "Avg grades below", align: "right", width: 140, render: (m) => m.avg_grades_below ?? "—" },
              { key: "awaiting_lab_test", label: "Awaiting lab test", align: "right", width: 140 },
            ]}
            rows={byMine}
            countLabel="mines"
            severityOf={(m) => (m.slippage_checks > 0 ? "High" : m.awaiting_lab_test > 0 ? "Medium" : null)}
            empty="No grade checks recorded yet."
          />
        </Card>
      )}

      <Card title="Grade checks">
        <Table
          columns={[
            { key: "checked_at", label: "Checked", width: 150, nowrap: true, render: (x) => fmt(x.checked_at) },
            ...(wide ? [{ key: "mine_name", label: "Mine", width: 150 }] : []),
            { key: "dispatch", label: "Dispatch", render: (x) => (
                <><strong>{x.mode} {x.vehicle_ref}</strong>
                  <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{x.dispatch_date} · {x.consignee} · {num(x.quantity_t)} t</div></>
              ) },
            { key: "grades", label: "Declared → tested", width: 150, render: (x) => `${x.declared_grade} → ${x.assessed_grade || "no test"}` },
            { key: "verdict", label: "Verdict", width: 190, render: (x) => <Badge>{x.verdict}</Badge> },
            { key: "status", label: "Mine's answer", width: 170, render: (x) => (
                <><Badge>{x.mine_answer ? `${x.mine_answer} by mine` : x.status}</Badge>
                  {x.status === "Closed" && <div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>Closed</div>}</>
              ) },
            { key: "open", label: "", width: 90, render: (x) => <Button variant="secondary" onClick={() => { setOpenId(x.check_id); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Open</Button> },
          ]}
          rows={list}
          countLabel="checks"
          severityOf={(x) => x.verdict}
          empty="No grade checks yet."
        />
      </Card>

      <Card title="Dispatches">
        <Table
          columns={[
            { key: "dispatch_date", label: "Date", width: 110, nowrap: true },
            ...(wide ? [{ key: "mine_name", label: "Mine", width: 150 }] : []),
            { key: "vehicle", label: "Rake / vehicle", render: (x) => <><strong>{x.mode} {x.vehicle_ref}</strong><div style={{ fontSize: 13, color: "var(--ink-soft)" }}>to {x.consignee}</div></> },
            { key: "quantity_t", label: "Tonnes", align: "right", width: 100, render: (x) => num(x.quantity_t) },
            { key: "declared_grade", label: "Declared", width: 150, render: (x) => (
                <>{x.declared_grade}
                  {x.official_grade && <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}> · official {x.official_grade}</span>}
                  {x.declared_above_official && <div style={{ fontSize: 12.5, color: "var(--sev-critical)", fontWeight: 600 }}>Above official grade</div>}
                  {x.dispatch_point && <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>{x.dispatch_point}</div>}</>
              ) },
            { key: "latest_verdict", label: "Latest check", width: 190, render: (x) => x.latest_verdict ? <Badge>{x.latest_verdict}</Badge> : <span style={{ color: "var(--ink-faint)" }}>Not checked</span> },
          ]}
          rows={dispatches || []}
          countLabel="dispatches"
          severityOf={(x) => (x.latest_verdict === "Grade slippage" ? "Critical" : x.declared_above_official ? "High" : null)}
          empty="No dispatches recorded yet."
        />
      </Card>

      {declaredList.length > 0 && (
        <Card title="Official annual grade declarations">
          <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
            The grade each company has declared for its mines and dispatch points for the year, under the Colliery
            Control (Amendment) Rules 2021. Dispatches are compared with these.
          </p>
          <Table
            columns={[
              { key: "area", label: "Area", width: 130, render: (r) => <>{r.area}<div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>{r.subsidiary} · {r.fy}</div></> },
              { key: "dispatch_point", label: "Mine / dispatch point", render: (r) => (
                  <><strong>{r.dispatch_point}</strong>{r.location && <span style={{ color: "var(--ink-soft)" }}> · {r.location}</span>}
                    <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>{r.point_type}{r.mine_names ? ` · official grade of ${r.mine_names}` : ""}</div></>
                ) },
              { key: "seams", label: "Coal (seams and share)", render: (r) => <span style={{ fontSize: 13 }}>{r.seams || "—"}</span> },
              { key: "grade", label: "Grade", width: 90, render: (r) => `${r.grade}${r.provisional ? " (P)" : ""}` },
            ]}
            rows={declaredList}
            countLabel="dispatch points"
          />
          <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: "8px 0 0" }}>
            Source: {declaredList[0].source}. (P) = provisional.
          </p>
        </Card>
      )}
    </Layout>
  );
}

export default function LogisticsPage() {
  return (
    <RoleGuard allowedRoles={["mine_official", "inspector", "corporate_admin", "regulator", "admin"]}>
      <LogisticsContent />
    </RoleGuard>
  );
}
