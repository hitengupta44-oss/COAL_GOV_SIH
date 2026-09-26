import { useEffect, useState } from "react";
import { Card, Table, Empty } from "./ui";
import { supabase } from "../lib/supabase";

// River water quality near a mine, from CPCB's National Water Quality
// Monitoring Programme, 2024 (real data). Each mine is linked to the three
// nearest coal-belt river stations within 25 km (migration 12) and every
// station is checked against CPCB's primary water quality criteria for
// outdoor bathing, the criteria printed on the NWMP tables themselves.
//
// A river station measures the river, not the mine's discharge: a failing
// station downstream of a mine is a reason to look, not proof of cause.

const SOURCE = "Source: CPCB, National Water Quality Monitoring Programme, river data 2024 (annual minimum and maximum). "
  + "Criteria: DO above 5 mg/L, pH 6.5–8.5, BOD below 3 mg/L, faecal coliform up to 2,500 MPN/100 mL. "
  + "Station positions are approximate (placed at the named town).";

const bad = { color: "var(--sev-critical)", fontWeight: 600, whiteSpace: "nowrap" };
const ok = { color: "var(--sev-low)", whiteSpace: "nowrap" };
const show = (v) => (v == null ? <span style={{ color: "var(--ink-faint)" }}>—</span> : Number(v).toLocaleString());

const COLUMNS = [
  { key: "do", label: "DO min (mg/L)", align: "right", width: 110,
    render: (r) => r.dissolved_oxygen_min == null ? show(null) : <span style={r.do_fails ? bad : ok}>{show(r.dissolved_oxygen_min)}</span> },
  { key: "ph", label: "pH", align: "right", width: 100,
    render: (r) => r.ph_min == null ? show(null) : <span style={r.ph_fails ? bad : ok}>{r.ph_min}–{r.ph_max}</span> },
  { key: "bod", label: "BOD max (mg/L)", align: "right", width: 115,
    render: (r) => r.bod_max == null ? show(null) : <span style={r.bod_fails ? bad : ok}>{show(r.bod_max)}</span> },
  { key: "fc", label: "Faecal coliform max", align: "right", width: 140,
    render: (r) => r.fecal_coliform_max == null ? show(null) : <span style={r.fc_fails ? bad : ok}>{show(r.fecal_coliform_max)}</span> },
  { key: "cond", label: "Conductivity max (µS/cm)", align: "right", width: 150, render: (r) => show(r.conductivity_max) },
];

const station = (r) => (
  <>
    <strong>{r.river || "River"}</strong>
    <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{r.monitoring_location}</div>
  </>
);

export default function RiverWater({ mineId }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    setRows(null);
    const q = mineId
      ? supabase.from("mine_water_quality_view").select("*").eq("mine_id", mineId).order("distance_km")
      : supabase.from("coalfield_river_quality_view").select("*").gt("mines_nearby", 0)
          .order("criteria_failed", { ascending: false }).order("mines_nearby", { ascending: false });
    q.then(({ data }) => setRows(data || []));
  }, [mineId]);

  const list = rows || [];
  const failing = list.filter((r) => r.criteria_failed > 0).length;

  if (mineId) {
    return (
      <Card title="Rivers near the mine (CPCB 2024)" severity={failing ? "High" : undefined}>
        {rows === null ? null : list.length === 0 ? (
          <Empty>No CPCB river monitoring station on record within 25 km of this mine.</Empty>
        ) : (
          <>
            <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
              {failing
                ? `${failing} of the ${list.length} nearest river stations fail at least one CPCB criterion.`
                : `The ${list.length} nearest river station${list.length > 1 ? "s meet" : " meets"} CPCB's criteria.`}
            </p>
            <Table
              columns={[
                { key: "station", label: "Station", render: station },
                { key: "distance_km", label: "Distance", align: "right", width: 90, render: (r) => `${r.distance_km} km` },
                ...COLUMNS,
              ]}
              rows={list}
              countLabel="stations"
              severityOf={(r) => (r.criteria_failed > 0 ? "High" : null)}
            />
          </>
        )}
        <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "8px 0 0" }}>{SOURCE}</p>
      </Card>
    );
  }

  return (
    <Card title="Coal-belt rivers (CPCB 2024)" severity={failing ? "High" : undefined}>
      <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
        {rows === null ? "Loading the coal-belt river stations."
          : `${failing} of ${list.length} river stations near coal mines fail at least one CPCB criterion. `
            + "Worst first; the last column is how many mines have the station among their three nearest."}
      </p>
      <Table
        columns={[
          { key: "station", label: "Station", render: (r) => <>{station(r)}<div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>{r.state}</div></> },
          ...COLUMNS.slice(0, 4),
          { key: "mines_nearby", label: "Mines nearby", align: "right", width: 110 },
        ]}
        rows={list}
        countLabel="stations"
        severityOf={(r) => (r.criteria_failed > 0 ? "High" : null)}
        empty="No coal-belt river data loaded. Run load_real_monitoring.py."
      />
      <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "8px 0 0" }}>{SOURCE}</p>
    </Card>
  );
}
