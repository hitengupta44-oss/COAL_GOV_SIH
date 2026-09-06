import { useEffect, useState } from "react";
import { Card, StatStrip, Table, Badge, Notice } from "./ui";
import { supabase } from "../lib/supabase";

// Cross-mine view of worker grievances, for corporate management and
// regulators.
//
// Both roles were already permitted to read grievances -- the RLS policy
// allows it -- but neither dashboard displayed them, so a worker's
// complaint was visible to their own mine official and then stopped.
// For a platform where labour welfare is part of the governance case,
// oversight with no sight of worker complaints is a gap, not a design
// choice. This closes the loop.
//
// The framing differs by role: a regulator is watching whether mines
// answer their workers, so the emphasis is on which sites are failing to
// respond. Corporate sees the same records as something to act on.
export default function GrievanceOverview({ mode = "regulator" }) {
  const [rows, setRows] = useState(null);
  const [mines, setMines] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      // The view computes is_overdue from each grievance's deadline, so
      // this agrees with the manager dashboard and the alerts engine
      // rather than re-deriving "late" a third way.
      const { data, error: err } = await supabase
        .from("grievance_status_view")
        .select("grievance_id, mine_id, category, description, status, priority, "
              + "date_filed, due_by, is_overdue, days_remaining, days_to_resolve, resolution_note")
        .order("date_filed", { ascending: false })
        .limit(500);
      if (err) return setError(err.message);
      setRows(data || []);

      const ids = [...new Set((data || []).map((r) => r.mine_id).filter(Boolean))];
      if (ids.length) {
        const { data: m } = await supabase
          .from("mines").select("mine_id, mine_name, state").in("mine_id", ids);
        setMines(Object.fromEntries((m || []).map((x) => [x.mine_id, x])));
      }
    })();
  }, []);

  const list = rows || [];
  const open = list.filter((g) => g.status !== "Resolved");
  const overdue = list.filter((g) => g.is_overdue);
  const resolved = list.filter((g) => g.status === "Resolved");

  // Median rather than mean: a handful of cases left open for months
  // would drag an average into telling you nothing about the typical
  // worker's experience.
  const times = resolved.map((g) => g.days_to_resolve).filter((n) => n != null).sort((a, b) => a - b);
  const medianDays = times.length ? times[Math.floor(times.length / 2)] : null;

  // Which mines are worst at answering. This is the number a regulator
  // actually wants: not how many complaints exist, but where they go
  // unanswered.
  const byMine = {};
  overdue.forEach((g) => {
    const key = g.mine_id;
    byMine[key] = (byMine[key] || 0) + 1;
  });
  const worstMines = Object.entries(byMine)
    .map(([id, n]) => ({ mine: mines[id]?.mine_name || "Unknown mine", state: mines[id]?.state || "—", overdue: n }))
    .sort((a, b) => b.overdue - a.overdue)
    .slice(0, 10);

  return (
    <>
      <Card title={mode === "regulator" ? "Worker grievances nationally" : "Worker grievances across your mines"}>
        {error && <Notice tone="error">{error}</Notice>}
        <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
          {mode === "regulator"
            ? "Complaints raised by workers and whether the mine answered them within its deadline. Safety and conduct cases carry a 7-day deadline, others 14."
            : "Complaints raised by workers at your mines. A rising overdue count is usually the first sign a site is under strain."}
        </p>

        <StatStrip
          items={[
            { label: "Open", value: open.length, tone: open.length ? "medium" : null },
            { label: "Past deadline", value: overdue.length, tone: overdue.length ? "critical" : null,
              note: overdue.length ? "Mine has not responded in time" : undefined },
            { label: "Resolved", value: resolved.length, tone: "low" },
            { label: "Typical time to resolve", value: medianDays == null ? "—" : `${medianDays} days`,
              note: medianDays == null ? undefined : "median" },
          ]}
        />

        {worstMines.length > 0 && (
          <>
            <h3 style={{ marginTop: 18, marginBottom: 8 }}>Mines with unanswered complaints</h3>
            <Table
              columns={[
                { key: "mine", label: "Mine", render: (r) => <strong>{r.mine}</strong> },
                { key: "state", label: "State", width: 170 },
                { key: "overdue", label: "Past deadline", width: 130, align: "right" },
              ]}
              rows={worstMines}
              countLabel="mines"
              severityOf={() => "Critical"}
              empty="Every mine is answering its workers within the deadline."
            />
          </>
        )}
      </Card>

      <Card title="Recent grievances">
        <Table
          columns={[
            { key: "mine", label: "Mine", width: 160,
              render: (g) => mines[g.mine_id]?.mine_name || "—" },
            { key: "category", label: "Category", width: 170 },
            { key: "description", label: "Detail" },
            { key: "date_filed", label: "Filed", width: 105, nowrap: true },
            { key: "due", label: "Response", width: 130, nowrap: true,
              render: (g) =>
                g.status === "Resolved"
                  ? <span style={{ color: "var(--ink-faint)" }}>
                      {g.days_to_resolve != null ? `in ${g.days_to_resolve} days` : "closed"}
                    </span>
                  : g.is_overdue
                    ? <span style={{ color: "var(--sev-critical)" }}>{Math.abs(g.days_remaining)} days over</span>
                    : (g.due_by || "—") },
            { key: "status", label: "Status", width: 110, render: (g) => <Badge>{g.status}</Badge> },
          ]}
          rows={list}
          countLabel="grievances"
          severityOf={(g) => (g.is_overdue ? "Critical" : g.status)}
          empty="No grievances on record."
        />
      </Card>
    </>
  );
}
