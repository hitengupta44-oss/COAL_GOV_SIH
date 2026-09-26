import { useEffect, useState } from "react";
import { Card, Table, Empty } from "./ui";
import { supabase } from "../lib/supabase";

// Ambient air quality around a mine, from CPCB's published 2023 annual
// averages (real data, not synthetic). Each mine is linked to its nearest
// CPCB monitoring city within 60 km (migration 11) and compared with the
// annual limits of the National Ambient Air Quality Standards, 2009.
//
// This is the air the community around the mine breathes. It complements,
// and does not replace, the mine's own stack and fugitive-dust readings
// recorded on this page.

const POLLUTANTS = [
  { key: "pm10", label: "PM10", limit: 60 },
  { key: "pm25", label: "PM2.5", limit: 40 },
  { key: "so2", label: "SO₂", limit: 50 },
  { key: "no2", label: "NO₂", limit: 40 },
];
const SOURCE = "Source: CPCB, National Ambient Air Quality Monitoring Programme, 2023 annual averages (µg/m³). "
  + "Limits: NAAQS 2009, annual.";

function Level({ value, limit }) {
  if (value == null) return <span style={{ color: "var(--ink-faint)" }}>Not measured</span>;
  const over = Number(value) > limit;
  return (
    <span style={{ color: over ? "var(--sev-critical)" : "var(--sev-low)", fontWeight: over ? 600 : 400, whiteSpace: "nowrap" }}>
      {Number(value)}
      {over && <span style={{ fontWeight: 400, fontSize: 13 }}> ({(Number(value) / limit).toFixed(1)}× limit)</span>}
    </span>
  );
}

export default function AmbientAir({ mineId }) {
  const [row, setRow] = useState(undefined);
  const [cities, setCities] = useState(null);

  useEffect(() => {
    setRow(undefined);
    if (mineId) {
      supabase.from("mine_air_quality_view").select("*").eq("mine_id", mineId).maybeSingle()
        .then(({ data }) => setRow(data || null));
    } else {
      supabase.from("coalfield_air_quality_view").select("*").gt("mines_nearby", 0)
        .order("pm10_annual_avg", { ascending: false, nullsFirst: false })
        .then(({ data }) => setCities(data || []));
    }
  }, [mineId]);

  if (mineId) {
    const over = row ? POLLUTANTS.filter((p) => row[`${p.key}_exceeds`]) : [];
    return (
      <Card title="Air quality around the mine (CPCB 2023)" severity={over.length ? "High" : undefined}>
        {row === undefined ? null : row === null ? (
          <Empty>No CPCB monitoring city within 60 km of this mine.</Empty>
        ) : (
          <>
            <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
              Nearest CPCB monitoring city: <strong>{row.city_town}</strong>, {row.state}, {row.distance_km} km away.
              {over.length > 0
                ? ` ${over.map((p) => p.label).join(" and ")} ${over.length > 1 ? "exceed their" : "exceeds its"} annual limit.`
                : " All measured pollutants are within their annual limits."}
            </p>
            <Table
              columns={[
                { key: "label", label: "Pollutant", width: 120 },
                { key: "value", label: "Annual average", align: "right", render: (p) => <Level value={row[`${p.key}_annual_avg`]} limit={p.limit} /> },
                { key: "limit", label: "Annual limit", align: "right", width: 130, render: (p) => p.limit },
              ]}
              rows={POLLUTANTS}
              countLabel="pollutants"
              severityOf={(p) => (row[`${p.key}_exceeds`] ? "High" : null)}
            />
          </>
        )}
        <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "8px 0 0" }}>{SOURCE}</p>
      </Card>
    );
  }

  const list = cities || [];
  const exceeding = list.filter((c) => c.pm10_exceeds || c.pm25_exceeds || c.so2_exceeds || c.no2_exceeds).length;
  return (
    <Card title="Air quality in the coal belt (CPCB 2023)" severity={exceeding ? "High" : undefined}>
      <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
        {list.length
          ? `${exceeding} of ${list.length} coal-belt monitoring cities exceed at least one annual limit. `
            + "Each mine is compared with the one city nearest to it, within 60 km."
          : "Loading the coal-belt monitoring cities."}
      </p>
      <Table
        columns={[
          { key: "city_town", label: "City", render: (c) => <><strong>{c.city_town}</strong><div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{c.state}</div></> },
          ...POLLUTANTS.map((p) => ({ key: p.key, label: p.label, align: "right", width: 110,
            render: (c) => <Level value={c[`${p.key}_annual_avg`]} limit={p.limit} /> })),
          { key: "mines_nearby", label: "Mines it covers", align: "right", width: 130 },
        ]}
        rows={list}
        countLabel="cities"
        severityOf={(c) => (c.pm10_exceeds || c.pm25_exceeds || c.so2_exceeds || c.no2_exceeds ? "High" : null)}
        empty="No coal-belt air-quality data loaded. Run apply_real_data.py."
      />
      <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "8px 0 0" }}>{SOURCE}</p>
    </Card>
  );
}
