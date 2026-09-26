-- ============================================================
-- Migration 09 — predictive compliance and operational anomalies
--
-- The risk engine so far looked backwards: it flagged what had already
-- gone wrong. This adds the forward-looking half the problem statement
-- asks for ("predictive alerts"):
--
--   compliance_predictions   for every obligation still Pending, the
--                            model's probability that it will be missed,
--                            and the factors that drove that estimate
--   'Predicted Non-Compliance' and 'Operational Anomaly' become valid
--                            risk-flag types, so they flow through the
--                            same response workflow as every other flag
--
-- Written by supabase/predictive_job.py (service role). Read-only for users.
-- Run after migration_08. Safe to re-run.
-- ============================================================

alter table ai_risk_flags drop constraint if exists ai_risk_flags_flag_type_check;
alter table ai_risk_flags add constraint ai_risk_flags_flag_type_check
  check (flag_type in ('Recurring Violation','Anomalous Accident Rate','Compliance Gap',
                       'Environmental Threshold Breach','Operational Anomaly',
                       'Predicted Non-Compliance'));

create table if not exists compliance_predictions (
    tracking_id     uuid primary key references compliance_tracking(tracking_id) on delete cascade,
    mine_id         uuid references mines(mine_id) not null,
    probability     numeric(5,4) not null check (probability between 0 and 1),
    risk_band       text not null check (risk_band in ('Low','Medium','High','Critical')),
    top_factors     jsonb default '[]'::jsonb,
    model_version   text not null,
    model_auc       numeric(5,4),
    generated_at    timestamptz default now()
);
create index if not exists idx_predictions_mine on compliance_predictions(mine_id, probability desc);

alter table compliance_predictions enable row level security;

drop policy if exists "Read predictions scoped" on compliance_predictions;
create policy "Read predictions scoped" on compliance_predictions
  for select using (is_oversight() or mine_id = auth_mine_id());

create or replace view compliance_prediction_view as
select p.tracking_id, p.mine_id, m.mine_name, m.state, m.subsidiary_id,
       c.due_date, c.status, i.requirement_summary, i.category, i.regulation_source, i.frequency,
       p.probability, p.risk_band, p.top_factors, p.model_version, p.model_auc, p.generated_at,
       (c.due_date - current_date) as days_to_due
  from compliance_predictions p
  join compliance_tracking c on c.tracking_id = p.tracking_id
  join statutory_compliance_items i on i.item_id = c.item_id
  left join mines m on m.mine_id = p.mine_id
 where c.status = 'Pending';
alter view compliance_prediction_view set (security_invoker = true);
grant select on compliance_prediction_view to authenticated;

-- ============================================================
-- END OF MIGRATION 09
-- ============================================================
