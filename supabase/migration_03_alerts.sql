-- ============================================================
-- Migration 03 — alerts, reminders and escalation
--
-- The platform could already show that something was overdue, but it
-- never told anyone. That is the difference between a report and a
-- governance system: an official should not have to open a dashboard to
-- discover that a statutory deadline passed three weeks ago.
--
-- Run in the Supabase SQL editor after migration_02_workflow.sql.
-- Safe to re-run.
-- ============================================================

create table if not exists alerts (
    alert_id        uuid primary key default uuid_generate_v4(),

    -- Who should act. Either a specific person, or a role at a mine when
    -- the right recipient is "whoever holds this post" rather than a
    -- named individual -- staff change, obligations don't.
    recipient_id    uuid references user_profiles(profile_id) on delete cascade,
    recipient_role  text,
    mine_id         uuid references mines(mine_id),

    category        text not null,       -- compliance | inspection | grievance | contractor
    severity        text not null,       -- Low | Medium | High | Critical
    title           text not null,
    body            text,

    -- What the alert is about, so the UI can link back to the record and
    -- so re-running the generator can recognise an alert it already
    -- raised instead of duplicating it.
    source_table    text,
    source_id       text,

    due_date        date,
    escalation_level int default 0,      -- 0 raised, 1 escalated, 2 senior
    status          text default 'Open', -- Open | Acknowledged | Resolved | Dismissed
    acknowledged_by uuid references user_profiles(profile_id),
    acknowledged_at timestamptz,
    created_at      timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alerts_severity_check') then
    alter table alerts add constraint alerts_severity_check
      check (severity in ('Low','Medium','High','Critical'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alerts_status_check') then
    alter table alerts add constraint alerts_status_check
      check (status in ('Open','Acknowledged','Resolved','Dismissed'));
  end if;
end $$;

-- One open alert per underlying record. Without this the generator would
-- raise a fresh alert on every run and bury the recipient in duplicates
-- of the same overdue item.
create unique index if not exists uniq_alert_source
  on alerts(source_table, source_id)
  where status in ('Open','Acknowledged');

create index if not exists idx_alerts_recipient on alerts(recipient_id, status);
create index if not exists idx_alerts_mine on alerts(mine_id, status);

-- Escalation ladder. An alert that nobody acknowledges should climb
-- rather than sit: this view says where each open alert currently stands,
-- and the generator promotes it accordingly.
create or replace view alert_escalation_view as
select a.*,
       (current_date - a.created_at::date)                              as age_days,
       case
         when a.status <> 'Open'                                        then 'Handled'
         when a.severity = 'Critical' and (current_date - a.created_at::date) >= 3  then 'Escalate'
         when a.severity = 'High'     and (current_date - a.created_at::date) >= 7  then 'Escalate'
         when a.severity = 'Medium'   and (current_date - a.created_at::date) >= 14 then 'Escalate'
         else 'Within window'
       end                                                              as escalation_state
  from alerts a;

-- ------------------------------------------------------------
-- Row level security
--
-- An alert is addressed to someone. People see what is addressed to
-- them, or to their role at their mine; oversight roles see everything.
-- ------------------------------------------------------------
alter table alerts enable row level security;

drop policy if exists "Read own alerts" on alerts;
create policy "Read own alerts" on alerts
  for select using (
    auth_role() in ('corporate_admin','regulator','admin')
    or recipient_id = (select profile_id from user_profiles where auth_uid = auth.uid())
    or (recipient_role = auth_role() and (mine_id is null or mine_id = auth_mine_id()))
  );

-- Acknowledging is the only write a normal user makes. Raising alerts is
-- the generator's job, running with the service-role key.
drop policy if exists "Acknowledge own alerts" on alerts;
create policy "Acknowledge own alerts" on alerts
  for update using (
    auth_role() in ('corporate_admin','regulator','admin')
    or recipient_id = (select profile_id from user_profiles where auth_uid = auth.uid())
    or (recipient_role = auth_role() and (mine_id is null or mine_id = auth_mine_id()))
  );

-- ============================================================
-- END OF MIGRATION 03
-- ============================================================
