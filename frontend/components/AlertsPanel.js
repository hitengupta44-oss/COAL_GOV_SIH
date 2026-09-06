import { useEffect, useState } from "react";
import { Card, Table, Badge, Button, Notice } from "./ui";
import { useAuth } from "../lib/useAuth";
import { supabase } from "../lib/supabase";

// Alerts addressed to this user, or to their role at their mine.
//
// The RLS policy on `alerts` already restricts what comes back, so this
// query does not repeat the access rules -- doing so in two places is how
// they drift apart. Ordering puts the most serious and most overdue
// first, because a list sorted by creation date buries the thing that
// matters under whatever happened to be scanned last.
const SEV_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

export default function AlertsPanel({ limit = 12 }) {
  const { profile } = useAuth();
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = async () => {
    const { data, error: err } = await supabase
      .from("alerts")
      .select("alert_id, category, severity, title, body, due_date, status, escalation_level, created_at")
      .in("status", ["Open", "Acknowledged"])
      .limit(200);
    if (err) return setError(err.message);
    const sorted = (data || []).sort(
      (a, b) =>
        (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) ||
        String(a.due_date || "9999").localeCompare(String(b.due_date || "9999"))
    );
    setAlerts(sorted);
  };

  useEffect(() => { load(); }, [profile?.profile_id]);

  // Acknowledging stops the escalation clock. It is not the same as
  // fixing the problem -- the alert closes on its own once the underlying
  // record is no longer overdue -- so the wording says "I've seen this",
  // not "done".
  const acknowledge = async (a) => {
    setBusy(a.alert_id);
    const { error: err } = await supabase
      .from("alerts")
      .update({
        status: "Acknowledged",
        acknowledged_by: profile?.profile_id,
        acknowledged_at: new Date().toISOString(),
      })
      .eq("alert_id", a.alert_id);
    setBusy(null);
    if (err) setError(`Could not acknowledge: ${err.message}`);
    else load();
  };

  const open = (alerts || []).filter((a) => a.status === "Open");
  const critical = open.filter((a) => a.severity === "Critical").length;

  return (
    <Card
      title="Needs your attention"
      action={
        alerts?.length ? (
          <span style={{ fontSize: 13, color: critical ? "var(--sev-critical)" : "var(--ink-soft)" }}>
            {open.length} open{critical ? `, ${critical} critical` : ""}
          </span>
        ) : null
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      <Table
        columns={[
          { key: "title", label: "What", render: (a) => (
              <>
                <strong>{a.title}</strong>
                {a.escalation_level > 0 && (
                  <span style={{ color: "var(--sev-critical)", fontSize: 12.5, marginLeft: 8 }}>
                    escalated
                  </span>
                )}
                <div style={{ color: "var(--ink-soft)", fontSize: 13.5 }}>{a.body}</div>
              </>
            ) },
          { key: "category", label: "Area", width: 110 },
          { key: "due_date", label: "Due", width: 110, nowrap: true,
            render: (a) => a.due_date || "—" },
          { key: "severity", label: "Severity", width: 100,
            render: (a) => <Badge>{a.severity}</Badge> },
          { key: "act", label: "", width: 140,
            render: (a) =>
              a.status === "Acknowledged" ? (
                <span style={{ color: "var(--ink-faint)", fontSize: 13 }}>Acknowledged</span>
              ) : (
                <Button variant="secondary" disabled={busy === a.alert_id}
                  onClick={() => acknowledge(a)}>
                  {busy === a.alert_id ? "Saving" : "I've seen this"}
                </Button>
              ) },
        ]}
        rows={(alerts || []).slice(0, limit)}
        severityOf={(a) => a.severity}
        empty="Nothing needs your attention. Alerts appear here when a deadline is approaching or has passed."
      />
    </Card>
  );
}
