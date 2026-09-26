-- ============================================================
-- Migration 10 — closing the remaining gaps against the problem statement
--
--   1. Recurring obligations      A statutory obligation is not a one-off:
--                                 once this month's return is filed, next
--                                 month's falls due. Until now nothing
--                                 created the next occurrence, so there was
--                                 no history -- and "recurring compliance
--                                 failures" could not even be detected.
--                                 Obligations now roll forward on their
--                                 statutory cycle, and Pending items past
--                                 their date are marked Overdue.
--   2. Recurring-failure flag     New risk-flag type fed by that history.
--   3. Contractor onboarding      Second digital approval workflow: a new
--      approval                   contractor cannot work until someone
--                                 other than the person who added them
--                                 approves -- and only with the four core
--                                 statutory documents valid.
--   4. Crew attendance            Contract labourers have no platform
--                                 accounts. Their supervisor records the
--                                 crew's headcount per shift, geo-tagged;
--                                 an unapproved or blacklisted contractor
--                                 cannot be recorded on site, and a crew
--                                 deployed with lapsed documents alerts the
--                                 mine at once.
--   5. Automatic statutory        Each month's returns are prepared by the
--      returns                    system for every mine with an official,
--                                 so a filing can be late but never
--                                 forgotten.
--   6. Rate limiting in the       The backend's rate limiter lived in the
--      database                   memory of one process: it reset on every
--                                 restart and could not work across more
--                                 than one server. It now lives here.
--
-- Run after migration_09_predictions.sql. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Recurring obligations
-- ------------------------------------------------------------

-- The statutory cycle of each frequency. Ongoing and event-based
-- requirements have no fixed legal cadence, so they are reviewed
-- quarterly -- the same assumption the seed data was built on.
create or replace function obligation_cycle(p_frequency text)
returns interval
language sql
immutable
as $$
  select case p_frequency
           when 'Weekly'  then interval '7 days'
           when 'Monthly' then interval '1 month'
           when 'Annual'  then interval '1 year'
           else                interval '90 days'
         end
$$;

-- One occurrence per obligation per due date. Needed so rolling forward
-- can never create the same period twice, however often it runs.
do $$
begin
  if not exists (select 1 from pg_indexes where indexname = 'uniq_obligation_period') then
    if exists (select 1 from compliance_tracking
                group by mine_id, item_id, due_date having count(*) > 1) then
      raise notice 'compliance_tracking has duplicate (mine, item, due date) rows; '
                   'uniq_obligation_period not created. Remove duplicates and re-run.';
    else
      create unique index uniq_obligation_period on compliance_tracking(mine_id, item_id, due_date);
    end if;
  end if;
end $$;

create index if not exists idx_compliance_mine_item_due on compliance_tracking(mine_id, item_id, due_date desc);

-- Creates the next occurrence of one obligation once the current one's
-- date has passed -- the cycle has moved on whether or not it was met.
-- The next occurrence's own due date then arrives in the normal reminder
-- window.
--
-- p_force: create it now whatever the date (used when an occurrence is
-- completed, so the official immediately sees what comes next).
--
-- Periods that passed with nothing done are NOT back-filled one by one:
-- the open Overdue occurrence already records the failure and carries the
-- alert. The next occurrence is placed in the current cycle instead, so a
-- weekly obligation ignored for a year produces one overdue item, not 52.
create or replace function roll_forward_obligation(p_mine uuid, p_item int, p_force boolean default false)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  latest   compliance_tracking;
  freq     text;
  cyc      interval;
  next_due date;
begin
  select * into latest from compliance_tracking
   where mine_id = p_mine and item_id = p_item and due_date is not null
   order by due_date desc limit 1;
  if latest.tracking_id is null or latest.status = 'Not Applicable' then
    return false;
  end if;

  select frequency into freq from statutory_compliance_items where item_id = p_item;
  cyc := obligation_cycle(freq);
  next_due := (latest.due_date + cyc)::date;

  if not p_force and latest.due_date >= current_date then
    return false;
  end if;
  while next_due < current_date loop
    next_due := (next_due + cyc)::date;
  end loop;

  insert into compliance_tracking (mine_id, item_id, due_date, status)
  values (p_mine, p_item, next_due, 'Pending')
  on conflict do nothing;
  return found;
end $$;

-- Scheduler entry point (alerts_engine.py): marks missed dates Overdue,
-- then starts the next cycle of every obligation whose date has passed.
-- Service role only.
create or replace function roll_forward_obligations()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  created    int := 0;
  marked     int;
begin
  update compliance_tracking
     set status = 'Overdue'
   where status = 'Pending' and due_date < current_date;
  get diagnostics marked = row_count;

  for r in
    select distinct on (c.mine_id, c.item_id) c.mine_id, c.item_id, c.due_date, c.status, i.frequency
      from compliance_tracking c
      join statutory_compliance_items i on i.item_id = c.item_id
     where c.due_date is not null
     order by c.mine_id, c.item_id, c.due_date desc
  loop
    if r.status <> 'Not Applicable' and r.due_date < current_date then
      if roll_forward_obligation(r.mine_id, r.item_id) then
        created := created + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('marked_overdue', marked, 'occurrences_created', created);
end $$;
revoke execute on function roll_forward_obligations() from public, anon, authenticated;
revoke execute on function roll_forward_obligation(uuid, int, boolean) from public, anon, authenticated;
grant execute on function roll_forward_obligations() to service_role;

-- Completing an occurrence schedules the next one immediately.
create or replace function compliance_after_complete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only the latest occurrence schedules the next one: completing an old,
  -- late occurrence must not push the schedule a further period ahead.
  if new.status = 'Completed' and old.status is distinct from 'Completed'
     and new.due_date is not null
     and not exists (select 1 from compliance_tracking
                      where mine_id = new.mine_id and item_id = new.item_id
                        and due_date > new.due_date) then
    perform roll_forward_obligation(new.mine_id, new.item_id, true);
  end if;
  return null;
end $$;

drop trigger if exists trg_compliance_after_complete on compliance_tracking;
create trigger trg_compliance_after_complete
  after update of status on compliance_tracking
  for each row execute function compliance_after_complete();

-- Each obligation's track record over the last 12 months: how many
-- occurrences fell due, how many were missed (still overdue, or done
-- after the date), and where the current occurrence stands. This is what
-- "recurring compliance failure" is measured against, and what the mine
-- official's screen shows beside each obligation.
create or replace view obligation_track_record_view as
with past as (
  select c.mine_id, c.item_id,
         count(*)                                                   as periods,
         count(*) filter (where c.status = 'Overdue'
                             or (c.status = 'Completed' and c.completed_date > c.due_date)) as missed,
         max(c.due_date)                                            as last_due
    from compliance_tracking c
   where c.due_date >= current_date - 365 and c.due_date < current_date
     and c.status <> 'Not Applicable'
   group by c.mine_id, c.item_id
)
select p.mine_id, p.item_id, i.requirement_summary, i.category, i.frequency, i.regulation_source,
       p.periods, p.missed, p.last_due,
       round(p.missed::numeric / nullif(p.periods, 0), 2) as miss_rate
  from past p
  join statutory_compliance_items i on i.item_id = p.item_id;
alter view obligation_track_record_view set (security_invoker = true);
grant select on obligation_track_record_view to authenticated;

-- ------------------------------------------------------------
-- 2. Recurring-failure flag type
-- ------------------------------------------------------------
alter table ai_risk_flags drop constraint if exists ai_risk_flags_flag_type_check;
alter table ai_risk_flags add constraint ai_risk_flags_flag_type_check
  check (flag_type in ('Recurring Violation','Anomalous Accident Rate','Compliance Gap',
                       'Environmental Threshold Breach','Operational Anomaly',
                       'Predicted Non-Compliance','Recurring Compliance Failure'));

-- ------------------------------------------------------------
-- 3. Contractor onboarding approval
--
--   added by contractor manager ─▶ Under Review ─▶ Active     (approved)
--                                        │
--                                        └──────▶ Rejected   (with reason)
--                                                    │
--                                   corrected and ◀──┘
--                                   resubmitted
--
-- Approval is by the mine official or corporate management, never by the
-- person who added the contractor, and only when the four core statutory
-- documents are on record and in date. A contractor whose contract ended
-- or was terminated goes back through review to work again.
-- ------------------------------------------------------------
alter table contractors add column if not exists created_by   uuid references user_profiles(profile_id);
alter table contractors add column if not exists reviewed_by  uuid references user_profiles(profile_id);
alter table contractors add column if not exists reviewed_at  timestamptz;
alter table contractors add column if not exists review_note  text;

alter table contractors drop constraint if exists contractors_status_check;
alter table contractors add constraint contractors_status_check
  check (status in ('Active','Under Review','Expired','Terminated','Rejected'));

-- The documents a contractor must hold, in date, before approval.
create or replace function contractor_required_documents()
returns text[]
language sql
immutable
as $$
  select array['Safety training certificate','Workmen compensation insurance',
               'Contract labour licence','PF registration']
$$;

-- Which required documents are missing or lapsed on a given date.
create or replace function contractor_document_gaps(p_contractor uuid, p_on date default current_date)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(d order by d), '{}')
    from unnest(contractor_required_documents()) d
   where not exists (
     select 1 from contractor_compliance cc
      where cc.contractor_id = p_contractor
        and cc.document_type = d
        and cc.valid_until is not null
        and cc.valid_until >= p_on)
$$;

create or replace function contractors_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.created_by  := auth_profile_id();
    new.status      := 'Under Review';
    new.blacklisted := false;
    new.is_synthetic := false;
    new.reviewed_by := null; new.reviewed_at := null; new.review_note := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_contractors_before_insert on contractors;
create trigger trg_contractors_before_insert
  before insert on contractors
  for each row execute function contractors_before_insert();

create or replace function contractors_workflow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r    text := auth_role();
  me   uuid := auth_profile_id();
  gaps text[];
begin
  if auth.uid() is null then return new; end if;

  if (new.mine_id, new.created_by) is distinct from (old.mine_id, old.created_by) then
    raise exception 'A contractor''s mine and originator cannot be changed.';
  end if;

  if new.status is not distinct from old.status then
    if (new.reviewed_by, new.reviewed_at, new.review_note)
       is distinct from (old.reviewed_by, old.reviewed_at, old.review_note) then
      raise exception 'Review details are recorded only by approving or rejecting.';
    end if;
    return new;
  end if;

  -- Approve or reject
  if old.status = 'Under Review' and new.status in ('Active','Rejected') then
    if r not in ('mine_official','corporate_admin','admin') then
      raise exception 'Contractors are approved by the mine official or corporate management.';
    end if;
    if me is not distinct from old.created_by then
      raise exception 'You added this contractor, so someone else must approve it.';
    end if;
    if new.status = 'Active' then
      if new.blacklisted then
        raise exception 'A blacklisted contractor cannot be approved.';
      end if;
      gaps := contractor_document_gaps(new.contractor_id);
      if array_length(gaps, 1) > 0 then
        raise exception 'Cannot approve: missing or lapsed %.', array_to_string(gaps, ', ');
      end if;
    elsif coalesce(btrim(new.review_note), '') = '' then
      raise exception 'Say why the contractor is not approved.';
    end if;
    new.reviewed_by := me;
    new.reviewed_at := now();
    return new;
  end if;

  -- Resubmit after rejection, or send back through review to work again
  if new.status = 'Under Review' and old.status in ('Rejected','Expired','Terminated') then
    if r not in ('contractor_manager','mine_official','corporate_admin','admin') then
      raise exception 'Only the contractor manager or the mine can resubmit a contractor.';
    end if;
    new.reviewed_by := null; new.reviewed_at := null;
    return new;
  end if;

  -- Ending a contract
  if new.status in ('Expired','Terminated') and old.status = 'Active' then
    if r not in ('mine_official','corporate_admin','admin') then
      raise exception 'Only the mine official or corporate management can end a contract.';
    end if;
    return new;
  end if;

  raise exception 'A contractor cannot move from % to %.', old.status, new.status;
end $$;

drop trigger if exists trg_contractors_workflow on contractors;
create trigger trg_contractors_workflow
  before update on contractors
  for each row execute function contractors_workflow();

-- Approvals reach the approver; a rejection goes back to the manager.
-- The alert source is 'contractor_approvals' -- alerts_engine.py already
-- manages alerts under 'contractors' (contract expiry) and would close
-- these as stale.
create or replace function contractors_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare t text := mine_label(new.mine_id) || ': ' || new.contractor_name;
begin
  if new.status = 'Under Review' and (tg_op = 'INSERT' or old.status <> 'Under Review') then
    perform raise_alert('mine_official', new.mine_id, 'approval', 'Medium',
      t || ' awaiting approval to work',
      coalesce(new.contract_type, 'Contract') || '. Check the statutory documents and approve or reject.',
      'contractor_approvals', new.contractor_id::text || ':review', current_date + 7);
  elsif tg_op = 'UPDATE' and old.status = 'Under Review' and new.status in ('Active','Rejected') then
    update alerts set status = 'Resolved'
     where source_table = 'contractor_approvals'
       and split_part(source_id, ':', 1) = new.contractor_id::text
       and status in ('Open','Acknowledged');
    if new.status = 'Rejected' then
      perform raise_alert('contractor_manager', new.mine_id, 'approval', 'High',
        t || ' not approved', new.review_note,
        'contractor_approvals', new.contractor_id::text || ':rejected', current_date + 7);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists trg_contractors_notify on contractors;
create trigger trg_contractors_notify
  after insert or update on contractors
  for each row execute function contractors_notify();

-- The register view selects c.*, which Postgres expands when the view is
-- created, so it is rebuilt to carry the new columns (see migration 07).
drop view if exists contractor_register_view;
create view contractor_register_view as
select c.*,
       case
         when c.blacklisted                                             then 'Blacklisted'
         when c.status = 'Under Review'                                 then 'Awaiting approval'
         when c.status = 'Rejected'                                     then 'Not approved'
         when c.status in ('Expired','Terminated')                      then 'Contract ended'
         when c.contract_end is null                                    then 'No end date'
         when c.contract_end < current_date                             then 'Contract expired'
         when c.contract_end < current_date + interval '60 days'        then 'Expiring soon'
         else 'In force'
       end                                                              as contract_state,
       (c.contract_end - current_date)                                  as days_to_contract_end,
       (select count(*) from contractor_compliance cc
         where cc.contractor_id = c.contractor_id
           and (cc.valid_until is null or cc.valid_until < current_date))
                                                                        as expired_documents,
       contractor_document_gaps(c.contractor_id)                        as document_gaps,
       cb.full_name                                                     as created_by_name,
       rb.full_name                                                     as reviewed_by_name
  from contractors c
  left join user_profiles cb on cb.profile_id = c.created_by
  left join user_profiles rb on rb.profile_id = c.reviewed_by;
alter view contractor_register_view set (security_invoker = true);
grant select on contractor_register_view to authenticated;

-- ------------------------------------------------------------
-- 4. Crew attendance for contract labour
-- ------------------------------------------------------------
create table if not exists contractor_crew_attendance (
    record_id            uuid primary key default uuid_generate_v4(),
    contractor_id        uuid not null references contractors(contractor_id) on delete cascade,
    mine_id              uuid references mines(mine_id),
    attendance_date      date not null default ((now() at time zone 'Asia/Kolkata')::date),
    shift                text not null check (shift in ('A','B','C')),
    headcount            int  not null check (headcount between 1 and 5000),
    supervisor_name      text,
    work_area            text,
    remarks              text,
    latitude             numeric(9,6),
    longitude            numeric(9,6),
    distance_from_mine_m numeric,
    within_geofence      boolean,
    documents_lapsed     boolean default false,
    lapsed_documents     text[] default '{}',
    recorded_by          uuid references user_profiles(profile_id),
    recorded_at          timestamptz default now(),
    is_synthetic         boolean default false,
    unique (contractor_id, attendance_date, shift)
);
create index if not exists idx_crew_mine_date on contractor_crew_attendance(mine_id, attendance_date desc);

create or replace function crew_attendance_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c     contractors;
  g     record;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into c from contractors where contractor_id = new.contractor_id;
  if c.contractor_id is null then
    raise exception 'Unknown contractor.';
  end if;
  new.mine_id := c.mine_id;

  if auth.uid() is not null then
    if tg_op = 'UPDATE' and new.contractor_id is distinct from old.contractor_id then
      raise exception 'A crew record cannot be moved to another contractor.';
    end if;
    new.recorded_by  := auth_profile_id();
    new.recorded_at  := now();
    new.is_synthetic := false;
    if new.attendance_date > today then
      raise exception 'Crew attendance cannot be recorded for a future date.';
    end if;
    if new.attendance_date < today - 2 and auth_role() not in ('corporate_admin','admin') then
      raise exception 'Crew attendance can be recorded up to 2 days back; older corrections go through corporate.';
    end if;
    -- The control that matters: nobody from an unapproved or blacklisted
    -- contractor is recorded as working on site.
    if c.blacklisted then
      raise exception '% is blacklisted and cannot be deployed on site.', c.contractor_name;
    end if;
    if c.status <> 'Active' then
      raise exception '% is not approved to work here (status: %).', c.contractor_name, c.status;
    end if;
  end if;

  new.lapsed_documents := contractor_document_gaps(new.contractor_id, new.attendance_date);
  new.documents_lapsed := coalesce(array_length(new.lapsed_documents, 1), 0) > 0;

  select * into g from geofence_check(new.mine_id, new.latitude, new.longitude);
  new.distance_from_mine_m := g.distance_m;
  new.within_geofence      := g.within;
  return new;
end $$;

drop trigger if exists trg_crew_attendance_before_write on contractor_crew_attendance;
create trigger trg_crew_attendance_before_write
  before insert or update on contractor_crew_attendance
  for each row execute function crew_attendance_before_write();

-- A crew on site under a lapsed safety certificate, insurance or licence
-- is a live breach, so the mine official hears about it immediately.
create or replace function crew_attendance_after_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.documents_lapsed and not new.is_synthetic then
    perform raise_alert('mine_official', new.mine_id, 'contractor', 'High',
      mine_label(new.mine_id) || ': ' || (select contractor_name from contractors where contractor_id = new.contractor_id)
        || ' has ' || new.headcount || ' workers on site with lapsed documents',
      'Shift ' || new.shift || ' on ' || new.attendance_date || '. Missing or lapsed: '
        || array_to_string(new.lapsed_documents, ', ') || '.',
      'contractor_crew_attendance', new.record_id::text, new.attendance_date + 1);
  end if;
  return null;
end $$;

drop trigger if exists trg_crew_attendance_after_write on contractor_crew_attendance;
create trigger trg_crew_attendance_after_write
  after insert or update on contractor_crew_attendance
  for each row execute function crew_attendance_after_write();

drop trigger if exists trg_audit_contractor_crew_attendance on contractor_crew_attendance;
create trigger trg_audit_contractor_crew_attendance
  after insert or update on contractor_crew_attendance
  for each row execute function audit_row_change('record_id');

alter table contractor_crew_attendance enable row level security;

drop policy if exists "Read crew attendance scoped" on contractor_crew_attendance;
create policy "Read crew attendance scoped" on contractor_crew_attendance
  for select using (
    is_oversight()
    or (auth_role() in ('mine_official','inspector','contractor_manager') and mine_id = auth_mine_id())
  );

drop policy if exists "Record crew attendance scoped" on contractor_crew_attendance;
create policy "Record crew attendance scoped" on contractor_crew_attendance
  for insert with check (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() in ('contractor_manager','mine_official')
        and exists (select 1 from contractors c
                     where c.contractor_id = contractor_crew_attendance.contractor_id
                       and c.mine_id = auth_mine_id()))
  );

drop policy if exists "Correct crew attendance scoped" on contractor_crew_attendance;
create policy "Correct crew attendance scoped" on contractor_crew_attendance
  for update using (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() in ('contractor_manager','mine_official') and mine_id = auth_mine_id())
  );

create or replace view crew_attendance_view as
select a.*, c.contractor_name, c.contract_type, p.full_name as recorded_by_name
  from contractor_crew_attendance a
  join contractors c on c.contractor_id = a.contractor_id
  left join user_profiles p on p.profile_id = a.recorded_by;
alter view crew_attendance_view set (security_invoker = true);
grant select on crew_attendance_view to authenticated;

-- ------------------------------------------------------------
-- 5. Automatic statutory returns
-- ------------------------------------------------------------
alter table statutory_returns add column if not exists auto_prepared boolean default false;

-- Contract labour now appears in every return (crew shifts, and how many
-- worker-shifts ran under lapsed documents). The rest of the function is
-- unchanged from migration 08.
create or replace function generate_return_snapshot(p_mine uuid, p_start date, p_end date)
returns jsonb
language sql
stable
set search_path = public
as $$
select jsonb_build_object(
  'mine', (select jsonb_build_object('mine_id', m.mine_id, 'name', m.mine_name, 'state', m.state,
                                     'district', m.district, 'type', m.mine_type,
                                     'subsidiary', s.subsidiary_code)
             from mines m left join subsidiaries s on s.subsidiary_id = m.subsidiary_id
            where m.mine_id = p_mine),
  'period', jsonb_build_object('from', p_start, 'to', p_end),

  'compliance', (select jsonb_build_object(
      'due_in_period',     count(*),
      'completed',         count(*) filter (where c.status = 'Completed'),
      'completed_on_time', count(*) filter (where c.status = 'Completed' and c.completed_date <= c.due_date),
      'overdue',           count(*) filter (where c.status = 'Overdue'),
      'pending',           count(*) filter (where c.status = 'Pending'),
      'not_applicable',    count(*) filter (where c.status = 'Not Applicable'))
     from compliance_tracking c
    where c.mine_id = p_mine and c.due_date between p_start and p_end),

  'overdue_obligations', coalesce((select jsonb_agg(x order by x->>'due_date') from (
      select jsonb_build_object('requirement', i.requirement_summary, 'regulation', i.regulation_source,
                                'category', i.category, 'due_date', c.due_date) as x
        from compliance_tracking c join statutory_compliance_items i on i.item_id = c.item_id
       where c.mine_id = p_mine and c.status = 'Overdue' and c.due_date <= p_end
       order by c.due_date limit 50) q), '[]'::jsonb),

  'inspections', (select jsonb_build_object(
      'findings',          count(*),
      'critical',          count(*) filter (where g.severity = 'Critical'),
      'high',              count(*) filter (where g.severity = 'High'),
      'closed_verified',   count(*) filter (where g.corrective_action_status = 'Closed'),
      'awaiting_verification', count(*) filter (where g.corrective_action_status = 'Action Taken'),
      'open',              count(*) filter (where g.corrective_action_status in ('Open','In Progress','Reopened','Overdue')),
      'past_deadline',     count(*) filter (where g.corrective_action_status <> 'Closed' and g.action_due_date < p_end),
      'outside_geofence',  count(*) filter (where g.within_geofence = false))
     from geo_inspections g
    where g.mine_id = p_mine and g."timestamp"::date between p_start and p_end),

  'incidents', (select jsonb_build_object(
      'total',             count(*),
      'fatal',             count(*) filter (where i.incident_type = 'Fatal Accident'),
      'serious',           count(*) filter (where i.incident_type = 'Serious Injury'),
      'dangerous_occurrences', count(*) filter (where i.incident_type in ('Dangerous Occurrence','Fire','Inundation')),
      'near_misses',       count(*) filter (where i.incident_type = 'Near Miss'),
      'persons_killed',    coalesce(sum(i.persons_killed), 0),
      'persons_injured',   coalesce(sum(i.persons_injured), 0),
      'notifiable',        count(*) filter (where i.notifiable),
      'notified_on_time',  count(*) filter (where i.notifiable and i.dgms_notified
                                             and i.dgms_notified_at <= i.dgms_notice_due_at))
     from incidents i
    where i.mine_id = p_mine and i.occurred_at::date between p_start and p_end),

  'production', (select jsonb_build_object(
      'days_reported',     count(distinct p.production_date),
      'produced_t',        coalesce(sum(p.coal_produced_t), 0),
      'dispatched_t',      coalesce(sum(p.coal_dispatched_t), 0),
      'overburden_m3',     coalesce(sum(p.overburden_removed_m3), 0),
      'target_t',          coalesce(sum(p.target_t), 0))
     from mine_production_daily p
    where p.mine_id = p_mine and p.production_date between p_start and p_end),

  'environment', (select jsonb_build_object(
      'readings',          coalesce(sum(e.n), 0),
      'exceedances',       coalesce(sum(e.x), 0),
      'exceedances_by_parameter', coalesce(jsonb_object_agg(e.parameter, e.x) filter (where e.x > 0), '{}'::jsonb))
     from (select parameter, count(*) as n, count(*) filter (where exceeds_limit) as x
             from env_readings
            where mine_id = p_mine and reading_date between p_start and p_end
            group by parameter) e),

  'attendance', (select jsonb_build_object(
      'check_ins',         count(*),
      'persons',           count(distinct a.profile_id),
      'geofence_exceptions', count(*) filter (where a.check_in_within_geofence = false
                                                or a.check_out_within_geofence = false))
     from attendance_checkins a
    where a.mine_id = p_mine and (a.check_in_at at time zone 'Asia/Kolkata')::date between p_start and p_end),

  'contract_labour', (select jsonb_build_object(
      'crew_shifts',        count(*),
      'worker_shifts',      coalesce(sum(w.headcount), 0),
      'contractors_deployed', count(distinct w.contractor_id),
      'shifts_with_lapsed_documents', count(*) filter (where w.documents_lapsed),
      'workers_under_lapsed_documents', coalesce(sum(w.headcount) filter (where w.documents_lapsed), 0))
     from contractor_crew_attendance w
    where w.mine_id = p_mine and w.attendance_date between p_start and p_end),

  'grievances', (select jsonb_build_object(
      'filed',             count(*),
      'resolved',          count(*) filter (where g.status = 'Resolved'),
      'escalated',         count(*) filter (where g.escalated))
     from grievances g
    where g.mine_id = p_mine and g.date_filed between p_start and p_end)
)
$$;
-- Prepares last month's returns -- and last quarter's environmental return
-- when a quarter has just ended -- for every mine that has a mine official
-- to submit them. Figures are generated by the database as usual; the
-- official reviews, adds remarks and submits. Returns that already exist
-- are left alone, so it is safe to run on every scheduler pass.
-- Service role only.
create or replace function auto_prepare_returns(p_today date default current_date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m_start date := (date_trunc('month', p_today) - interval '1 month')::date;
  m_end   date := (date_trunc('month', p_today) - interval '1 day')::date;
  q_start date := (date_trunc('quarter', p_today) - interval '3 months')::date;
  q_end   date := (date_trunc('quarter', p_today) - interval '1 day')::date;
  n       int := 0;
  added   int;
  mine    uuid;
begin
  for mine in
    select distinct mine_id from user_profiles where role = 'mine_official' and mine_id is not null
  loop
    insert into statutory_returns (mine_id, return_type, period_start, period_end, status, auto_prepared)
    values (mine, 'Monthly Safety & Compliance Return', m_start, m_end, 'Draft', true),
           (mine, 'Monthly Production Return',          m_start, m_end, 'Draft', true)
    on conflict (mine_id, return_type, period_start) do nothing;
    get diagnostics added = row_count;
    n := n + added;

    -- The quarterly return is prepared in the first month of a new quarter.
    if date_trunc('month', p_today) = date_trunc('quarter', p_today) then
      insert into statutory_returns (mine_id, return_type, period_start, period_end, status, auto_prepared)
      values (mine, 'Quarterly Environmental Return', q_start, q_end, 'Draft', true)
      on conflict (mine_id, return_type, period_start) do nothing;
      get diagnostics added = row_count;
      n := n + added;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function auto_prepare_returns(date) from public, anon, authenticated;
grant execute on function auto_prepare_returns(date) to service_role;

-- The view lists its columns explicitly, so it is rebuilt to add
-- auto_prepared.
drop view if exists statutory_return_view;
create view statutory_return_view as
select r.return_id, r.mine_id, m.mine_name, m.state, m.subsidiary_id,
       r.return_type, r.period_start, r.period_end, r.status, r.snapshot, r.snapshot_hash,
       r.remarks, r.review_note, r.revision,
       r.prepared_at, r.submitted_at, r.reviewed_at,
       r.submitted_by, r.reviewed_by,
       pb.full_name as prepared_by_name,
       sb.full_name as submitted_by_name,
       rb.full_name as reviewed_by_name,
       r.auto_prepared,
       (r.period_end + 7) as submission_due
  from statutory_returns r
  left join mines m on m.mine_id = r.mine_id
  left join user_profiles pb on pb.profile_id = r.prepared_by
  left join user_profiles sb on sb.profile_id = r.submitted_by
  left join user_profiles rb on rb.profile_id = r.reviewed_by;
alter view statutory_return_view set (security_invoker = true);
grant select on statutory_return_view to authenticated;

-- ------------------------------------------------------------
-- 6. Rate limiting in the database
--
-- The backend used a dictionary in its own memory: it reset whenever the
-- Space restarted and each extra server would have had its own count.
-- A shared table works across restarts and any number of servers. The
-- backend falls back to its in-memory limiter if this call fails, so a
-- database hiccup never locks everyone out.
-- ------------------------------------------------------------
create table if not exists api_rate_hits (
    hit_id   bigserial primary key,
    key      text not null,
    hit_at   timestamptz not null default now()
);
create index if not exists idx_rate_hits_key_time on api_rate_hits(key, hit_at desc);
alter table api_rate_hits enable row level security;   -- no policies: service role only

-- Records a call and says whether the caller is over the limit.
create or replace function hit_rate_limit(p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from api_rate_hits where key = p_key and hit_at < now() - make_interval(secs => p_window_seconds);
  insert into api_rate_hits (key) values (p_key);
  select count(*) into n from api_rate_hits
   where key = p_key and hit_at >= now() - make_interval(secs => p_window_seconds);
  return n > p_max;
end $$;
revoke execute on function hit_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function hit_rate_limit(text, int, int) to service_role;

-- ------------------------------------------------------------
-- Indexes for the queries the dashboards and jobs run most, so they stay
-- fast as mines, years and records accumulate.
-- ------------------------------------------------------------
create index if not exists idx_geo_inspections_status_due on geo_inspections(corrective_action_status, action_due_date);
create index if not exists idx_alerts_status_created      on alerts(status, created_at);
create index if not exists idx_audit_log_table            on audit_log(table_affected, chain_seq desc);
create index if not exists idx_grievances_mine_date       on grievances(mine_id, date_filed desc);
create index if not exists idx_contractors_mine           on contractors(mine_id);
create index if not exists idx_env_exceed                 on env_readings(mine_id, exceeds_limit, reading_date desc);

-- ============================================================
-- END OF MIGRATION 10
-- ============================================================
