import { useEffect, useState } from "react";
import { Card, Table, Badge } from "./ui";
import { supabase } from "../lib/supabase";

// Obligations the model expects to be missed, while there is still time
// to act. Each row carries the reasons behind the estimate -- a score
// alone gives a mine official nothing to act on and a regulator nothing
// to audit. Model and accuracy are stated, not hidden.
export default function PredictionsPanel({ wide = false, subsidiaryId = null, limit = 40 }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let q = supabase.from("compliance_prediction_view")
      .select("tracking_id, mine_name, state, requirement_summary, category, regulation_source, due_date, "
            + "days_to_due, probability, risk_band, top_factors, model_version, model_auc, generated_at")
      .in("risk_band", ["Critical", "High"])
      .order("probability", { ascending: false })
      .limit(limit);
    if (subsidiaryId) q = q.eq("subsidiary_id", subsidiaryId);
    q.then(({ data }) => setRows(data || []));
  }, [subsidiaryId, limit]);

  const meta = rows?.[0];
  return (
    <Card title="Likely to slip">
      <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
        Pending obligations the model estimates are likely to be missed, with the factors behind each estimate.
        {meta && <> Model {meta.model_version}, cross-validated AUC {Number(meta.model_auc).toFixed(2)}, updated{" "}
          {new Date(meta.generated_at).toLocaleDateString([], { dateStyle: "medium" })}.</>}
      </p>
      <Table
        columns={[
          ...(wide ? [{ key: "mine_name", label: "Mine", width: 160,
            render: (r) => <><strong>{r.mine_name}</strong><div style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>{r.state}</div></> }] : []),
          { key: "req", label: "Obligation", render: (r) => (
              <>
                <strong>{r.requirement_summary}</strong>
                <div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>{r.category} · {r.regulation_source}</div>
              </>
            ) },
          { key: "due_date", label: "Due", width: 120, nowrap: true,
            render: (r) => <>{r.due_date}<div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>in {r.days_to_due} days</div></> },
          { key: "probability", label: "Chance missed", width: 120, align: "right",
            render: (r) => <><strong>{Math.round(r.probability * 100)}%</strong> <Badge>{r.risk_band}</Badge></> },
          { key: "why", label: "Why", render: (r) => (
              <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                {(r.top_factors || []).map((f) => f.factor).join("; ") || "General pattern"}
              </span>
            ) },
        ]}
        rows={rows || []}
        countLabel="obligations"
        severityOf={(r) => r.risk_band}
        empty="Nothing currently looks likely to slip. Predictions refresh daily."
      />
    </Card>
  );
}
