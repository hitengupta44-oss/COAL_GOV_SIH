import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Scatter, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, Legend,
} from "recharts";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import { Card, StatStrip, Table, Badge, Field, Button, Notice, Empty } from "../../components/ui";
import { useAuth } from "../../lib/useAuth";
import { supabase } from "../../lib/supabase";

// Production reporting and environmental monitoring at mine level.
//
// Production: the mine official enters each shift's figures (up to 7 days
// back; older corrections go through corporate). Each day is scored against
// the same mine's trailing 30 days in the database, and a day more than
// 2.5 standard deviations out is marked -- an unexplained collapse can be
// an unreported stoppage, an unexplained spike output booked to the wrong
// day. The risk engine turns repeated anomalies into a flag.
//
// Environment: readings are checked against the statutory limit at the
// moment they are entered, the limit is stored with the reading, and a
// breach raises an alert immediately. Readings cannot be edited: a wrong
// value is corrected by entering the right one, so a breach cannot
// quietly disappear.

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const num = (v) => (v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 }));

function MinePicker({ value, onChange }) {
  const [mines, setMines] = useState([]);
  useEffect(() => {
    // Mines with any production reported, most recent first.
    supabase.from("mine_production_daily").select("mine_id").order("production_date", { ascending: false }).limit(1000)
      .then(async ({ data }) => {
        const ids = [...new Set((data || []).map((r) => r.mine_id))];
        if (!ids.length) return;
        const { data: m } = await supabase.from("mines").select("mine_id, mine_name, state").in("mine_id", ids);
        const sorted = (m || []).sort((a, b) => a.mine_name.localeCompare(b.mine_name));
        setMines(sorted);
        if (!value && sorted[0]) onChange(sorted[0].mine_id);
      });
  }, []);
  return (
    <select value={value || ""} onChange={(e) => onChange(e.target.value)} style={{ width: 280 }}>
      {mines.map((m) => <option key={m.mine_id} value={m.mine_id}>{m.mine_name}, {m.state}</option>)}
    </select>
  );
}

function ProductionEntry({ mineId, onSaved }) {
  const blank = { production_date: today(), shift: "A", coal_produced_t: "", coal_dispatched_t: "",
                  overburden_removed_m3: "", target_t: "", remarks: "" };
  const [f, setF] = useState(blank);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const n = (v) => (v === "" ? null : Number(v));

  const save = async () => {
    if (f.coal_produced_t === "") return setStatus({ tone: "error", text: "Enter the coal produced." });
    setBusy(true); setStatus(null);
    const { error } = await supabase.from("mine_production_daily").upsert({
      mine_id: mineId, production_date: f.production_date, shift: f.shift,
      coal_produced_t: n(f.coal_produced_t), coal_dispatched_t: n(f.coal_dispatched_t),
      overburden_removed_m3: n(f.overburden_removed_m3), target_t: n(f.target_t), remarks: f.remarks || null,
    }, { onConflict: "mine_id,production_date,shift" });
    setBusy(false);
    if (error) return setStatus({ tone: "error", text: error.message });
    setStatus({ tone: "success", text: `Shift ${f.shift} on ${f.production_date} saved.` });
    setF({ ...blank, production_date: f.production_date, shift: f.shift === "A" ? "B" : f.shift === "B" ? "C" : "A" });
    onSaved();
  };

  return (
    <Card title="Report shift production">
      {status && <Notice tone={status.tone}>{status.text}</Notice>}
      <div className="formgrid">
        <Field label="Date"><input type="date" value={f.production_date} min={daysAgo(7)} max={today()} onChange={set("production_date")} /></Field>
        <Field label="Shift">
          <select value={f.shift} onChange={set("shift")}>
            <option value="A">A (06–14)</option><option value="B">B (14–22)</option><option value="C">C (22–06)</option>
          </select>
        </Field>
        <Field label="Coal produced (t)"><input type="number" min="0" value={f.coal_produced_t} onChange={set("coal_produced_t")} /></Field>
        <Field label="Target (t)"><input type="number" min="0" value={f.target_t} onChange={set("target_t")} /></Field>
        <Field label="Coal dispatched (t)"><input type="number" min="0" value={f.coal_dispatched_t} onChange={set("coal_dispatched_t")} /></Field>
        <Field label="Overburden removed (m³)"><input type="number" min="0" value={f.overburden_removed_m3} onChange={set("overburden_removed_m3")} /></Field>
      </div>
      <Field label="Remarks (e.g. reason for a shortfall)"><input value={f.remarks} onChange={set("remarks")} /></Field>
      <Button onClick={save} disabled={busy || !mineId}>{busy ? "Saving" : "Save shift"}</Button>
      <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "10px 0 0" }}>
        Saving the same date and shift again replaces the earlier figure; the change is kept in the audit trail.
      </p>
    </Card>
  );
}

function EnvEntry({ mineId, limits, onSaved }) {
  const [f, setF] = useState({ reading_date: today(), parameter: "PM10", value: "", station_label: "" });
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const lim = limits.find((l) => l.parameter === f.parameter);

  const save = async () => {
    if (f.value === "") return setStatus({ tone: "error", text: "Enter the measured value." });
    setBusy(true); setStatus(null);
    const { data, error } = await supabase.from("env_readings").insert({
      mine_id: mineId, reading_date: f.reading_date, parameter: f.parameter,
      value: Number(f.value), station_label: f.station_label || null,
    }).select("exceeds_limit").single();
    setBusy(false);
    if (error) return setStatus({ tone: "error", text: error.message });
    setStatus(data?.exceeds_limit
      ? { tone: "error", text: `${f.parameter} ${f.value} is outside the statutory limit. The mine official has been alerted.` }
      : { tone: "success", text: `${f.parameter} ${f.value} recorded, within limit.` });
    setF({ ...f, value: "" });
    onSaved();
  };

  return (
    <Card title="Record an environmental reading">
      {status && <Notice tone={status.tone}>{status.text}</Notice>}
      <div className="formgrid">
        <Field label="Date"><input type="date" value={f.reading_date} max={today()} onChange={set("reading_date")} /></Field>
        <Field label="Parameter">
          <select value={f.parameter} onChange={set("parameter")}>
            {limits.map((l) => <option key={l.parameter} value={l.parameter}>{l.parameter} ({l.unit})</option>)}
          </select>
        </Field>
        <Field label={`Value${lim ? ` (${lim.unit})` : ""}`}><input type="number" step="any" value={f.value} onChange={set("value")} /></Field>
        <Field label="Station"><input value={f.station_label} onChange={set("station_label")} placeholder="e.g. Haul road, CHP" /></Field>
      </div>
      {lim && (
        <p style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: -4 }}>
          Limit: {lim.min_value != null ? `${lim.min_value}–` : "up to "}{lim.max_value} {lim.unit} · {lim.basis}
        </p>
      )}
      <Button onClick={save} disabled={busy || !mineId}>{busy ? "Saving" : "Record reading"}</Button>
    </Card>
  );
}

function OperationsContent() {
  const { profile } = useAuth();
  const role = profile?.role;
  const wide = ["corporate_admin", "regulator", "admin"].includes(role);
  const [mineId, setMineId] = useState(wide ? null : profile?.mine_id);
  const [prod, setProd] = useState(null);
  const [env, setEnv] = useState(null);
  const [limits, setLimits] = useState([]);
  const [param, setParam] = useState("PM10");

  useEffect(() => {
    supabase.from("env_limits").select("*").order("medium").then(({ data }) => setLimits(data || []));
  }, []);

  const load = async () => {
    if (!mineId) return;
    const since = daysAgo(60);
    const [{ data: p }, { data: e }] = await Promise.all([
      supabase.from("production_anomaly_view").select("*").eq("mine_id", mineId)
        .gte("production_date", since).order("production_date"),
      supabase.from("env_readings").select("reading_date, parameter, value, limit_min, limit_max, exceeds_limit, station_label")
        .eq("mine_id", mineId).gte("reading_date", daysAgo(90)).order("reading_date"),
    ]);
    setProd(p || []);
    setEnv(e || []);
  };
  useEffect(() => { load(); }, [mineId]);

  const chart = useMemo(() => (prod || []).map((r) => ({
    date: r.production_date.slice(5), produced: Number(r.produced_t), target: r.target_t ? Number(r.target_t) : null,
    anomaly: r.is_anomaly ? Number(r.produced_t) : null,
  })), [prod]);

  const last30 = (prod || []).filter((r) => r.production_date >= daysAgo(30));
  const produced30 = last30.reduce((s, r) => s + Number(r.produced_t || 0), 0);
  const target30 = last30.reduce((s, r) => s + Number(r.target_t || 0), 0);
  const anomalies = (prod || []).filter((r) => r.is_anomaly);
  const breaches = (env || []).filter((r) => r.exceeds_limit);
  const lim = limits.find((l) => l.parameter === param);
  const envSeries = (env || []).filter((r) => r.parameter === param)
    .map((r) => ({ date: r.reading_date.slice(5), value: Number(r.value), breach: r.exceeds_limit ? Number(r.value) : null }));
  const canProd = role === "mine_official" || role === "corporate_admin" || role === "admin";
  const canEnv = canProd || role === "inspector";

  return (
    <Layout title="Production & environment" subtitle={wide ? "Mine-level returns" : ""}>
      {wide && (
        <div style={{ marginBottom: 20 }}>
          <MinePicker value={mineId} onChange={setMineId} />
        </div>
      )}

      <StatStrip items={[
        { label: "Produced, last 30 days", value: `${num(produced30)} t`,
          note: target30 ? `${Math.round((100 * produced30) / target30)}% of ${num(target30)} t target` : undefined },
        { label: "Anomalous days, 60 days", value: anomalies.length, tone: anomalies.length ? "high" : null },
        { label: "Environmental breaches, 90 days", value: breaches.length, tone: breaches.length ? "critical" : null },
      ]} />

      {canProd && mineId && !wide && <ProductionEntry mineId={mineId} onSaved={load} />}

      <Card title="Daily production against target">
        {chart.length === 0 ? <Empty>No production reported for this mine yet.</Empty> : (
          <div style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer>
              <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={{ fontSize: 12 }} width={64} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <Tooltip formatter={(v, n) => [`${num(v)} t`, n]} />
                <Legend wrapperStyle={{ fontSize: 13 }} />
                <Line type="monotone" dataKey="target" name="Target" stroke="var(--ink-faint)" strokeDasharray="4 4" dot={false} />
                <Line type="monotone" dataKey="produced" name="Produced" stroke="var(--primary)" strokeWidth={2} dot={false} />
                <Scatter dataKey="anomaly" name="Anomalous day" fill="var(--sev-critical)" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        {anomalies.length > 0 && (
          <Table
            columns={[
              { key: "production_date", label: "Day", width: 120, nowrap: true },
              { key: "produced_t", label: "Produced (t)", align: "right", render: (r) => num(r.produced_t) },
              { key: "trailing_mean", label: "Usual (30-day mean)", align: "right", render: (r) => num(r.trailing_mean) },
              { key: "z_score", label: "Deviation (z)", align: "right", width: 120 },
            ]}
            rows={anomalies}
            countLabel="days"
            severityOf={() => "High"}
          />
        )}
      </Card>

      {canEnv && mineId && !wide && <EnvEntry mineId={mineId} limits={limits} onSaved={load} />}

      <Card title="Environmental readings" action={
        <select value={param} onChange={(e) => setParam(e.target.value)} style={{ width: 200 }}>
          {limits.map((l) => <option key={l.parameter} value={l.parameter}>{l.parameter}</option>)}
        </select>
      }>
        {envSeries.length === 0 ? <Empty>No {param} readings in the last 90 days.</Empty> : (
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <ComposedChart data={envSeries} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 12 }} width={48} />
                <Tooltip formatter={(v) => [`${v} ${lim?.unit || ""}`, param]} />
                {lim?.max_value != null && (
                  <ReferenceLine y={Number(lim.max_value)} stroke="var(--sev-critical)" strokeDasharray="4 4"
                    label={{ value: `Limit ${lim.max_value}`, fontSize: 12, fill: "var(--sev-critical)", position: "insideTopRight" }} />
                )}
                {lim?.min_value != null && (
                  <ReferenceLine y={Number(lim.min_value)} stroke="var(--sev-critical)" strokeDasharray="4 4"
                    label={{ value: `Min ${lim.min_value}`, fontSize: 12, fill: "var(--sev-critical)", position: "insideBottomRight" }} />
                )}
                <Line type="monotone" dataKey="value" stroke="var(--primary)" strokeWidth={2} dot={{ r: 2 }} />
                <Scatter dataKey="breach" fill="var(--sev-critical)" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        {lim && <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "8px 0 0" }}>Limit basis: {lim.basis}</p>}
      </Card>

      <Card title="Readings outside statutory limits" severity={breaches.length ? "Critical" : undefined}>
        <Table
          columns={[
            { key: "reading_date", label: "Date", width: 120, nowrap: true },
            { key: "parameter", label: "Parameter", width: 150 },
            { key: "value", label: "Measured", align: "right", width: 100 },
            { key: "limit", label: "Limit", align: "right", width: 110,
              render: (r) => r.limit_max != null ? `≤ ${r.limit_max}` : `≥ ${r.limit_min}` },
            { key: "station_label", label: "Station", render: (r) => r.station_label || "—" },
          ]}
          rows={[...breaches].reverse()}
          countLabel="readings"
          severityOf={() => "Critical"}
          empty="Every reading in the last 90 days was within its limit."
        />
      </Card>
    </Layout>
  );
}

export default function OperationsPage() {
  return (
    <RoleGuard allowedRoles={["mine_official", "inspector", "corporate_admin", "regulator", "admin"]}>
      <OperationsContent />
    </RoleGuard>
  );
}
