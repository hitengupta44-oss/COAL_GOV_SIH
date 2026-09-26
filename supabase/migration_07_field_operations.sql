-- ============================================================
-- Migration 07 — field operations
--
-- Closes the gaps between the platform and what the problem statement
-- asks for at the mine level:
--
--   1. Geo-fence validation      every geo-tagged record is checked against
--                                the mine's own coordinates
--   2. Corrective action loop    finding -> action -> independent
--                                verification -> closed (or reopened)
--   3. Incident reporting        accidents, dangerous occurrences and near
--                                misses, with instant alerts upward
--   4. Attendance                geo-fenced personal check-in / check-out
--   5. Production reporting      daily mine-level production entry
--   6. Environmental monitoring  readings checked against statutory limits
--   7. Evidence storage          photos and documents in a private bucket
--   8. Database-level audit      every change to these records is written
--                                to audit_log by the database itself
--
-- Rules are enforced in the database, not the interface: a direct API call
-- with a valid token is held to exactly the same workflow as the app.
--
-- Run after migration_06_rls_hardening.sql. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Shared helpers
-- ------------------------------------------------------------

-- Great-circle distance in metres. Plain SQL rather than PostGIS
-- geography so it works identically on any Postgres.
create or replace function haversine_m(lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric)
returns numeric
language sql
immutable
as $$
  select case when lat1 is null or lon1 is null or lat2 is null or lon2 is null then null
  else round((2 * 6371000 * asin(sqrt(
      power(sin(radians((lat2 - lat1)::float8) / 2), 2)
    + cos(radians(lat1::float8)) * cos(radians(lat2::float8))
    * power(sin(radians((lon2 - lon1)::float8) / 2), 2))))::numeric, 0)
  end
$$;

-- How far from a mine's recorded point a record may be and still count as
-- "at the mine". Coal mines are large -- an opencast lease runs for
-- kilometres -- and about a third of the source coordinates are marked
-- approximate, so the radius is generous and depends on that accuracy.
-- Tune these two numbers to your lease boundaries when you have them.
create or replace function geofence_radius_m(accuracy text)
returns numeric
language sql
immutable
as $$
  select case when lower(coalesce(accuracy, '')) = 'exact' then 5000 else 25000 end::numeric
$$;

-- Distance from a mine and whether that is inside its geo-fence.
-- within_geofence is NULL (unknown) when either point is missing, which is
-- deliberately different from false.
create or replace function geofence_check(p_mine uuid, p_lat numeric, p_lon numeric,
                                          out distance_m numeric, out within boolean)
language sql
stable
security definer
set search_path = public
as $$
  select haversine_m(p_lat, p_lon, m.latitude, m.longitude),
         case when haversine_m(p_lat, p_lon, m.latitude, m.longitude) is null then null
              else haversine_m(p_lat, p_lon, m.latitude, m.longitude) <= geofence_radius_m(m.geo_accuracy)
         end
    from mines m where m.mine_id = p_mine
$$;

-- Raise an alert from inside the database (triggers use this). Runs as
-- the owner so a worker reporting an incident can cause an alert to reach
-- corporate management without being able to write alerts directly.
create or replace function raise_alert(p_role text, p_mine uuid, p_category text, p_severity text,
                                       p_title text, p_body text, p_source_table text,
                                       p_source_id text, p_due date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into alerts (recipient_role, mine_id, category, severity, title, body,
                      source_table, source_id, due_date)
  values (p_role, p_mine, p_category, p_severity, p_title, p_body,
          p_source_table, p_source_id, p_due)
  on conflict do nothing;
end $$;

create or replace function mine_label(p_mine uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(mine_name, 'Unknown mine') from mines where mine_id = p_mine
$$;

-- ------------------------------------------------------------
-- 1 + 2. Inspections: geo-fence and the corrective action loop
-- ------------------------------------------------------------
alter table geo_inspections add column if not exists distance_from_mine_m numeric;
alter table geo_inspections add column if not exists within_geofence      boolean;
alter table geo_inspections add column if not exists synced_at            timestamptz default now();
alter table geo_inspections add column if not exists assigned_to          uuid references user_profiles(profile_id);
alter table geo_inspections add column if not exists action_due_date      date;
alter table geo_inspections add column if not exists action_taken         text;
alter table geo_inspections add column if not exists action_photo_url     text;
alter table geo_inspections add column if not exists action_submitted_by  uuid references user_profiles(profile_id);
alter table geo_inspections add column if not exists action_submitted_at  timestamptz;
alter table geo_inspections add column if not exists verified_by          uuid references user_profiles(profile_id);
alter table geo_inspections add column if not exists verified_at          timestamptz;
alter table geo_inspections add column if not exists verification_note    text;
alter table geo_inspections add column if not exists reopened_count       int default 0;

-- "Action Taken" (fixed, awaiting verification) and "Reopened" (rejected
-- on verification) are new. Without "Action Taken" there is no way to
-- tell a finding the mine SAYS it fixed from one someone has checked.
alter table geo_inspections drop constraint if exists geo_inspections_corrective_action_status_check;
alter table geo_inspections add constraint geo_inspections_corrective_action_status_check
  check (corrective_action_status in ('Open','In Progress','Action Taken','Reopened','Closed','Overdue'));

-- Time allowed to fix a finding, by severity. Working assumption; align it
-- with your company SOP.
create or replace function action_days_for(sev text)
returns int
language sql
immutable
as $$
  select case sev when 'Critical' then 2 when 'High' then 7 when 'Medium' then 15 else 30 end
$$;

create or replace function geo_inspections_before_insert()
returns trigger
language plpgsql
as $$
declare g record;
begin
  select * into g from geofence_check(new.mine_id, new.latitude, new.longitude);
  new.distance_from_mine_m := g.distance_m;
  new.within_geofence      := g.within;
  new.corrective_action_status := coalesce(new.corrective_action_status, 'Open');
  if new.action_due_date is null then
    new.action_due_date := (coalesce(new."timestamp", now()))::date + action_days_for(new.severity);
  end if;
  new.synced_at := now();
  return new;
end $$;

drop trigger if exists trg_geo_inspections_before_insert on geo_inspections;
create trigger trg_geo_inspections_before_insert
  before insert on geo_inspections
  for each row execute function geo_inspections_before_insert();

-- The workflow itself. Jobs running with the service role (auth.uid() is
-- null) are exempt -- that is how the scheduler marks items Overdue.
create or replace function geo_inspections_workflow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r  text := auth_role();
  me uuid := auth_profile_id();
begin
  if auth.uid() is null then
    return new;
  end if;

  -- What was observed is evidence. Nobody edits it after the fact.
  if (new.mine_id, new.inspector_id, new."timestamp", new.latitude, new.longitude,
      new.observation_type, new.severity, new.notes, new.photo_url,
      new.distance_from_mine_m, new.within_geofence, new.is_synthetic)
     is distinct from
     (old.mine_id, old.inspector_id, old."timestamp", old.latitude, old.longitude,
      old.observation_type, old.severity, old.notes, old.photo_url,
      old.distance_from_mine_m, old.within_geofence, old.is_synthetic) then
    raise exception 'The recorded finding cannot be edited. Record a new inspection instead.';
  end if;

  if old.corrective_action_status = 'Closed' then
    raise exception 'This finding is closed.';
  end if;

  -- Same status: only planning fields (who, by when) may change, and only
  -- by the people accountable for the site.
  if new.corrective_action_status = old.corrective_action_status then
    if r not in ('mine_official','corporate_admin','admin') then
      raise exception 'Only the mine official can reassign or reschedule a finding.';
    end if;
    if (new.action_taken, new.action_photo_url, new.action_submitted_by, new.action_submitted_at,
        new.verified_by, new.verified_at, new.verification_note, new.reopened_count)
       is distinct from
       (old.action_taken, old.action_photo_url, old.action_submitted_by, old.action_submitted_at,
        old.verified_by, old.verified_at, old.verification_note, old.reopened_count) then
      raise exception 'Use the workflow steps to record action or verification.';
    end if;
    return new;
  end if;

  -- Verification fields are only ever written by the verification step.
  if new.corrective_action_status not in ('Closed','Reopened') and
     (new.verified_by, new.verified_at, new.verification_note, new.reopened_count)
     is distinct from (old.verified_by, old.verified_at, old.verification_note, old.reopened_count) then
    raise exception 'Verification fields are set only when a finding is verified.';
  end if;

  case new.corrective_action_status

  when 'In Progress' then
    if old.corrective_action_status not in ('Open','Reopened','Overdue') then
      raise exception 'Cannot move from % to In Progress.', old.corrective_action_status;
    end if;
    if r not in ('mine_official','corporate_admin','admin') then
      raise exception 'Only the mine official starts corrective action.';
    end if;
    if (new.action_taken, new.action_photo_url) is distinct from (old.action_taken, old.action_photo_url) then
      raise exception 'Record the action with the Action Taken step.';
    end if;

  when 'Action Taken' then
    if old.corrective_action_status not in ('Open','In Progress','Reopened','Overdue') then
      raise exception 'Cannot move from % to Action Taken.', old.corrective_action_status;
    end if;
    if r not in ('mine_official','corporate_admin','admin') then
      raise exception 'Only the mine official records corrective action.';
    end if;
    if coalesce(btrim(new.action_taken), '') = '' then
      raise exception 'Describe the corrective action taken.';
    end if;
    -- A Critical finding needs photographic evidence of the fix.
    if new.severity = 'Critical' and coalesce(new.action_photo_url, '') = '' then
      raise exception 'A photo of the fix is required to close out a Critical finding.';
    end if;
    new.action_submitted_by := me;
    new.action_submitted_at := now();

  when 'Closed', 'Reopened' then
    if old.corrective_action_status <> 'Action Taken' then
      raise exception 'Only a finding with recorded action can be verified.';
    end if;
    if r not in ('inspector','corporate_admin','admin') then
      raise exception 'Verification is done by an inspector or corporate management.';
    end if;
    -- The whole point of verification: whoever did the fix cannot sign it off.
    if me is not distinct from old.action_submitted_by then
      raise exception 'You recorded this action, so someone else must verify it.';
    end if;
    if (new.action_taken, new.action_photo_url, new.action_submitted_by, new.action_submitted_at)
       is distinct from
       (old.action_taken, old.action_photo_url, old.action_submitted_by, old.action_submitted_at) then
      raise exception 'Verification cannot change the recorded action.';
    end if;
    if new.corrective_action_status = 'Reopened' then
      if coalesce(btrim(new.verification_note), '') = '' then
        raise exception 'Say why the action was not sufficient before reopening.';
      end if;
      new.reopened_count := coalesce(old.reopened_count, 0) + 1;
      -- A reopened finding gets a fresh, shorter deadline.
      new.action_due_date := current_date + greatest(1, action_days_for(new.severity) / 2);
    else
      new.reopened_count := old.reopened_count;
    end if;
    new.verified_by := me;
    new.verified_at := now();

  else
    raise exception 'Status % is set by the system, not by hand.', new.corrective_action_status;
  end case;

  return new;
end $$;

drop trigger if exists trg_geo_inspections_workflow on geo_inspections;
create trigger trg_geo_inspections_workflow
  before update on geo_inspections
  for each row execute function geo_inspections_workflow();

drop policy if exists "Act on findings scoped" on geo_inspections;
create policy "Act on findings scoped" on geo_inspections
  for update using (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() in ('mine_official','inspector') and mine_id = auth_mine_id())
  );

-- Called by the scheduler (service role only) to mark missed deadlines.
create or replace function refresh_overdue_actions()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update geo_inspections
     set corrective_action_status = 'Overdue'
   where corrective_action_status in ('Open','In Progress','Reopened')
     and action_due_date < current_date;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function refresh_overdue_actions() from public, anon, authenticated;
grant execute on function refresh_overdue_actions() to service_role;

-- Findings with names attached, for the dashboards.
create or replace view corrective_action_view as
select g.inspection_id, g.mine_id, m.mine_name, m.state, m.subsidiary_id,
       g."timestamp", g.observation_type, g.severity, g.notes, g.photo_url,
       g.latitude, g.longitude, g.distance_from_mine_m, g.within_geofence,
       g.corrective_action_status, g.action_due_date, g.action_taken, g.action_photo_url,
       g.action_submitted_at, g.verified_at, g.verification_note, g.reopened_count,
       g.inspector_id, g.action_submitted_by, g.verified_by,
       insp.full_name as inspector_name,
       asg.full_name  as assigned_to_name,
       sub.full_name  as action_by_name,
       ver.full_name  as verified_by_name,
       (g.corrective_action_status <> 'Closed' and g.action_due_date < current_date) as is_late,
       (g.action_due_date - current_date) as days_left
  from geo_inspections g
  left join mines m            on m.mine_id = g.mine_id
  left join user_profiles insp on insp.profile_id = g.inspector_id
  left join user_profiles asg  on asg.profile_id  = g.assigned_to
  left join user_profiles sub  on sub.profile_id  = g.action_submitted_by
  left join user_profiles ver  on ver.profile_id  = g.verified_by;
alter view corrective_action_view set (security_invoker = true);
grant select on corrective_action_view to authenticated;

-- The joined user_profiles rows are protected by "Read own profile", so a
-- mine official would otherwise see blank names for everyone but
-- themselves. Names of people at your own mine are not sensitive; this
-- narrow policy lets them show.
drop policy if exists "Read colleagues at own mine" on user_profiles;
create policy "Read colleagues at own mine" on user_profiles
  for select using (
    is_oversight() or (mine_id is not null and mine_id = auth_mine_id())
  );

-- ------------------------------------------------------------
-- 3. Incident reporting
-- ------------------------------------------------------------
create table if not exists incidents (
    incident_id            uuid primary key default uuid_generate_v4(),
    mine_id                uuid references mines(mine_id) not null,
    reported_by            uuid references user_profiles(profile_id),
    occurred_at            timestamptz not null,
    reported_at            timestamptz default now(),
    incident_type          text not null,
    severity               text,
    location_description   text,
    latitude               numeric(9,6),
    longitude              numeric(9,6),
    distance_from_mine_m   numeric,
    within_geofence        boolean,
    persons_injured        int default 0,
    persons_killed         int default 0,
    description            text not null,
    immediate_action       text,
    photo_url              text,
    status                 text default 'Reported',
    notifiable             boolean default false,
    dgms_notice_due_at     timestamptz,
    dgms_notified          boolean default false,
    dgms_notified_at       timestamptz,
    dgms_notice_ref        text,
    investigation_findings text,
    root_cause             text,
    closed_by              uuid references user_profiles(profile_id),
    closed_at              timestamptz,
    is_synthetic           boolean default false,
    created_at             timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'incidents_type_check') then
    alter table incidents add constraint incidents_type_check check (incident_type in (
      'Fatal Accident','Serious Injury','Minor Injury','Dangerous Occurrence',
      'Fire','Inundation','Roof/Side Fall','Equipment Failure','Near Miss','Environmental Release'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'incidents_status_check') then
    alter table incidents add constraint incidents_status_check
      check (status in ('Reported','Under Investigation','Closed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'incidents_severity_check') then
    alter table incidents add constraint incidents_severity_check
      check (severity in ('Low','Medium','High','Critical'));
  end if;
end $$;

create index if not exists idx_incidents_mine on incidents(mine_id, occurred_at desc);

create or replace function incidents_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare g record;
begin
  -- Identity comes from the session, never from the request body.
  if auth.uid() is not null then
    new.reported_by := auth_profile_id();
    new.reported_at := now();
    new.status      := 'Reported';
    new.dgms_notified := false;
    new.dgms_notified_at := null;
    new.closed_by := null; new.closed_at := null;
  end if;
  if new.occurred_at > now() + interval '5 minutes' then
    raise exception 'An incident cannot be dated in the future.';
  end if;

  new.severity := coalesce(new.severity, case
    when new.incident_type = 'Fatal Accident' or coalesce(new.persons_killed,0) > 0 then 'Critical'
    when new.incident_type in ('Serious Injury','Dangerous Occurrence','Fire','Inundation','Roof/Side Fall') then 'High'
    when new.incident_type in ('Minor Injury','Equipment Failure','Environmental Release') then 'Medium'
    else 'Low' end);
  -- A death always makes it Critical, whatever the reporter picked.
  if coalesce(new.persons_killed,0) > 0 then new.severity := 'Critical'; end if;

  -- Accidents and dangerous occurrences must be notified to DGMS (Mines
  -- Act 1952, s.23). The 24-hour window here is the platform's working
  -- deadline -- set it to match your statutory form and SOP.
  new.notifiable := new.incident_type in
    ('Fatal Accident','Serious Injury','Dangerous Occurrence','Fire','Inundation')
    or coalesce(new.persons_killed,0) > 0;
  new.dgms_notice_due_at := case when new.notifiable then new.occurred_at + interval '24 hours' end;

  select * into g from geofence_check(new.mine_id, new.latitude, new.longitude);
  new.distance_from_mine_m := g.distance_m;
  new.within_geofence      := g.within;
  return new;
end $$;

drop trigger if exists trg_incidents_before_insert on incidents;
create trigger trg_incidents_before_insert
  before insert on incidents
  for each row execute function incidents_before_insert();

-- Alerts go out the moment the row lands -- not on the next scheduled run.
-- Serious incidents reach corporate management and the regulator directly.
create or replace function incidents_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t    text := mine_label(new.mine_id) || ': ' || new.incident_type || ' reported';
  body text := left(new.description, 400)
               || case when new.notifiable
                       then ' Statutory notice to DGMS due by '
                            || to_char(new.dgms_notice_due_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST.'
                       else '' end;
begin
  perform raise_alert('mine_official', new.mine_id, 'incident', new.severity, t, body,
                      'incidents', new.incident_id::text, new.dgms_notice_due_at::date);
  if new.severity in ('High','Critical') then
    perform raise_alert('corporate_admin', new.mine_id, 'incident', new.severity, t, body,
                        'incidents', new.incident_id::text || ':corporate', new.dgms_notice_due_at::date);
    perform raise_alert('regulator', new.mine_id, 'incident', new.severity, t, body,
                        'incidents', new.incident_id::text || ':regulator', new.dgms_notice_due_at::date);
  end if;
  return null;
end $$;

drop trigger if exists trg_incidents_after_insert on incidents;
create trigger trg_incidents_after_insert
  after insert on incidents
  for each row execute function incidents_after_insert();

create or replace function incidents_workflow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;

  -- The report is the record of what happened. It stays as filed.
  if (new.mine_id, new.reported_by, new.occurred_at, new.reported_at, new.incident_type,
      new.severity, new.latitude, new.longitude, new.persons_injured, new.persons_killed,
      new.description, new.photo_url, new.notifiable, new.dgms_notice_due_at)
     is distinct from
     (old.mine_id, old.reported_by, old.occurred_at, old.reported_at, old.incident_type,
      old.severity, old.latitude, old.longitude, old.persons_injured, old.persons_killed,
      old.description, old.photo_url, old.notifiable, old.dgms_notice_due_at) then
    raise exception 'The incident report cannot be edited once filed.';
  end if;

  if old.status = 'Closed' then
    raise exception 'This incident is closed.';
  end if;

  if new.dgms_notified and not old.dgms_notified then
    if coalesce(btrim(new.dgms_notice_ref), '') = '' then
      raise exception 'Enter the reference of the notice sent to DGMS.';
    end if;
    new.dgms_notified_at := now();
  elsif (new.dgms_notified, new.dgms_notice_ref, new.dgms_notified_at)
        is distinct from (old.dgms_notified, old.dgms_notice_ref, old.dgms_notified_at) then
    raise exception 'A DGMS notification, once recorded, cannot be changed.';
  end if;

  if new.status = 'Closed' then
    if coalesce(btrim(new.investigation_findings), '') = '' or coalesce(btrim(new.root_cause), '') = '' then
      raise exception 'Record the investigation findings and root cause before closing.';
    end if;
    if old.notifiable and not new.dgms_notified then
      raise exception 'A notifiable incident cannot be closed until the DGMS notice is recorded.';
    end if;
    new.closed_by := auth_profile_id();
    new.closed_at := now();
  elsif new.status = 'Reported' and old.status <> 'Reported' then
    raise exception 'An investigation cannot be un-started.';
  end if;
  return new;
end $$;

drop trigger if exists trg_incidents_workflow on incidents;
create trigger trg_incidents_workflow
  before update on incidents
  for each row execute function incidents_workflow();

-- When the obligation behind an incident alert is met, the alerts close.
create or replace function incidents_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.status = 'Closed' and old.status <> 'Closed')
     or (new.notifiable and new.dgms_notified and not old.dgms_notified) then
    update alerts set status = 'Resolved'
     where source_table = 'incidents'
       and split_part(source_id, ':', 1) = new.incident_id::text
       and status in ('Open','Acknowledged');
  end if;
  return null;
end $$;

drop trigger if exists trg_incidents_after_update on incidents;
create trigger trg_incidents_after_update
  after update on incidents
  for each row execute function incidents_after_update();

alter table incidents enable row level security;

drop policy if exists "Read incidents scoped" on incidents;
create policy "Read incidents scoped" on incidents
  for select using (is_oversight() or mine_id = auth_mine_id());

-- Anyone attached to a mine can report -- a near miss seen by a worker is
-- exactly the report a safety system most wants and most often loses.
drop policy if exists "Report incidents at own mine" on incidents;
create policy "Report incidents at own mine" on incidents
  for insert with check (
    auth_role() in ('worker','inspector','contractor_manager','mine_official','corporate_admin','admin')
    and (mine_id = auth_mine_id() or auth_role() in ('corporate_admin','admin'))
  );

drop policy if exists "Investigate incidents scoped" on incidents;
create policy "Investigate incidents scoped" on incidents
  for update using (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
  );

create or replace view incident_view as
select i.*, m.mine_name, m.state, m.subsidiary_id,
       rep.full_name as reported_by_name,
       (i.notifiable and not i.dgms_notified and i.dgms_notice_due_at < now()) as notice_overdue
  from incidents i
  left join mines m on m.mine_id = i.mine_id
  left join user_profiles rep on rep.profile_id = i.reported_by;
alter view incident_view set (security_invoker = true);
grant select on incident_view to authenticated;

-- ------------------------------------------------------------
-- 4. Attendance: personal, geo-fenced check-in and check-out
--
-- attendance_records (schema.sql) holds shift totals. This table holds the
-- individual events those totals should come from, so a headcount can be
-- traced to people and places instead of being typed in.
-- ------------------------------------------------------------
create table if not exists attendance_checkins (
    checkin_id                uuid primary key default uuid_generate_v4(),
    profile_id                uuid references user_profiles(profile_id) not null,
    mine_id                   uuid references mines(mine_id) not null,
    shift                     text,
    check_in_at               timestamptz not null default now(),
    check_in_lat              numeric(9,6),
    check_in_lon              numeric(9,6),
    check_in_distance_m       numeric,
    check_in_within_geofence  boolean,
    check_out_at              timestamptz,
    check_out_lat             numeric(9,6),
    check_out_lon             numeric(9,6),
    check_out_distance_m      numeric,
    check_out_within_geofence boolean,
    captured_offline          boolean default false,
    is_synthetic              boolean default false,
    created_at                timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'attendance_checkins_shift_check') then
    alter table attendance_checkins add constraint attendance_checkins_shift_check
      check (shift in ('A','B','C'));
  end if;
end $$;

-- One open check-in per person: you cannot be clocked in twice.
create unique index if not exists uniq_open_checkin
  on attendance_checkins(profile_id) where check_out_at is null;
create index if not exists idx_checkins_mine_time on attendance_checkins(mine_id, check_in_at desc);

-- Standard three-shift pattern: A 06-14, B 14-22, C 22-06 (IST).
create or replace function shift_for(ts timestamptz)
returns text
language sql
immutable
as $$
  select case
    when extract(hour from ts at time zone 'Asia/Kolkata') >= 6
     and extract(hour from ts at time zone 'Asia/Kolkata') < 14 then 'A'
    when extract(hour from ts at time zone 'Asia/Kolkata') >= 14
     and extract(hour from ts at time zone 'Asia/Kolkata') < 22 then 'B'
    else 'C' end
$$;

-- A time stamped on a device that was offline is accepted only within a
-- plausible window; anything else would let a check-in be backdated.
create or replace function accept_device_time(p_claimed timestamptz, p_offline boolean)
returns timestamptz
language plpgsql
stable
as $$
begin
  if not coalesce(p_offline, false) or p_claimed is null then
    return now();
  end if;
  if p_claimed > now() + interval '5 minutes' or p_claimed < now() - interval '72 hours' then
    raise exception 'Offline time is outside the accepted 72-hour window.';
  end if;
  return p_claimed;
end $$;

create or replace function attendance_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare g record;
begin
  if auth.uid() is not null then
    new.profile_id  := auth_profile_id();
    new.mine_id     := auth_mine_id();
    new.check_in_at := accept_device_time(new.check_in_at, new.captured_offline);
    new.check_out_at := null;
    new.is_synthetic := false;
  end if;
  if new.mine_id is null then
    raise exception 'Your account is not attached to a mine, so there is nowhere to check in.';
  end if;
  new.shift := shift_for(new.check_in_at);
  select * into g from geofence_check(new.mine_id, new.check_in_lat, new.check_in_lon);
  new.check_in_distance_m      := g.distance_m;
  new.check_in_within_geofence := g.within;
  return new;
end $$;

drop trigger if exists trg_attendance_before_insert on attendance_checkins;
create trigger trg_attendance_before_insert
  before insert on attendance_checkins
  for each row execute function attendance_before_insert();

create or replace function attendance_before_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare g record;
begin
  if auth.uid() is null then return new; end if;
  if old.check_out_at is not null then
    raise exception 'You have already checked out of this shift.';
  end if;
  if (new.profile_id, new.mine_id, new.shift, new.check_in_at, new.check_in_lat, new.check_in_lon,
      new.check_in_distance_m, new.check_in_within_geofence)
     is distinct from
     (old.profile_id, old.mine_id, old.shift, old.check_in_at, old.check_in_lat, old.check_in_lon,
      old.check_in_distance_m, old.check_in_within_geofence) then
    raise exception 'A check-in cannot be changed.';
  end if;
  new.check_out_at := accept_device_time(new.check_out_at, new.captured_offline);
  if new.check_out_at < old.check_in_at then
    raise exception 'Check-out cannot be before check-in.';
  end if;
  select * into g from geofence_check(new.mine_id, new.check_out_lat, new.check_out_lon);
  new.check_out_distance_m      := g.distance_m;
  new.check_out_within_geofence := g.within;
  return new;
end $$;

drop trigger if exists trg_attendance_before_update on attendance_checkins;
create trigger trg_attendance_before_update
  before update on attendance_checkins
  for each row execute function attendance_before_update();

alter table attendance_checkins enable row level security;

drop policy if exists "Read checkins scoped" on attendance_checkins;
create policy "Read checkins scoped" on attendance_checkins
  for select using (
    is_oversight()
    or profile_id = auth_profile_id()
    or (auth_role() in ('mine_official','inspector') and mine_id = auth_mine_id())
  );

drop policy if exists "Check in self" on attendance_checkins;
create policy "Check in self" on attendance_checkins
  for insert with check (
    auth_role() in ('worker','inspector','contractor_manager','mine_official')
    and profile_id = auth_profile_id()
    and mine_id = auth_mine_id()
  );

drop policy if exists "Check out self" on attendance_checkins;
create policy "Check out self" on attendance_checkins
  for update using (profile_id = auth_profile_id());

create or replace view attendance_checkin_view as
select a.*, p.full_name, p.role,
       (a.check_in_within_geofence = false or a.check_out_within_geofence = false) as geofence_exception,
       round(extract(epoch from (coalesce(a.check_out_at, now()) - a.check_in_at)) / 3600.0, 1) as hours_on_site
  from attendance_checkins a
  left join user_profiles p on p.profile_id = a.profile_id;
alter view attendance_checkin_view set (security_invoker = true);
grant select on attendance_checkin_view to authenticated;

-- Daily totals per mine and shift -- what attendance_records used to hold
-- by hand, derived from the individual events.
create or replace view attendance_daily_view as
select a.mine_id,
       (a.check_in_at at time zone 'Asia/Kolkata')::date as attendance_date,
       a.shift,
       count(*)                                             as present,
       count(*) filter (where a.check_in_within_geofence = false
                           or a.check_out_within_geofence = false) as geofence_exceptions,
       count(*) filter (where a.check_out_at is null)       as still_on_site
  from attendance_checkins a
 group by 1, 2, 3;
alter view attendance_daily_view set (security_invoker = true);
grant select on attendance_daily_view to authenticated;

-- ------------------------------------------------------------
-- 5. Daily production reporting (mine level)
--
-- production_records holds published subsidiary/national figures. This
-- is the mine's own daily return, entered at the mine.
-- ------------------------------------------------------------
create table if not exists mine_production_daily (
    record_id              uuid primary key default uuid_generate_v4(),
    mine_id                uuid references mines(mine_id) not null,
    production_date        date not null,
    shift                  text check (shift in ('A','B','C')),
    coal_produced_t        numeric(12,2) not null check (coal_produced_t >= 0),
    coal_dispatched_t      numeric(12,2) check (coal_dispatched_t >= 0),
    overburden_removed_m3  numeric(12,2) check (overburden_removed_m3 >= 0),
    target_t               numeric(12,2) check (target_t >= 0),
    remarks                text,
    entered_by             uuid references user_profiles(profile_id),
    is_synthetic           boolean default false,
    created_at             timestamptz default now(),
    unique (mine_id, production_date, shift)
);

create or replace function production_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.entered_by := auth_profile_id();
    new.is_synthetic := false;
    -- Returns are filed promptly or not at all; a figure entered weeks
    -- later is reconstruction, not reporting.
    if new.production_date > current_date then
      raise exception 'Production cannot be reported for a future date.';
    end if;
    if auth_role() = 'mine_official' and new.production_date < current_date - 7 then
      raise exception 'Production older than 7 days must be corrected by corporate management.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_production_before_write on mine_production_daily;
create trigger trg_production_before_write
  before insert or update on mine_production_daily
  for each row execute function production_before_write();

alter table mine_production_daily enable row level security;

drop policy if exists "Read production scoped" on mine_production_daily;
create policy "Read production scoped" on mine_production_daily
  for select using (is_oversight() or mine_id = auth_mine_id());

drop policy if exists "Report production at own mine" on mine_production_daily;
create policy "Report production at own mine" on mine_production_daily
  for insert with check (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
  );

drop policy if exists "Correct production at own mine" on mine_production_daily;
create policy "Correct production at own mine" on mine_production_daily
  for update using (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
  );

-- Anomaly scoring: each day's output against the same mine's trailing
-- 30-day pattern. A z-score beyond +/-2.5 is unusual enough to ask about
-- -- an unexplained collapse can mean a stoppage nobody reported, an
-- unexplained spike can mean output recorded against the wrong day.
create or replace view production_anomaly_view as
with daily as (
  select mine_id, production_date,
         sum(coal_produced_t) as produced_t,
         sum(target_t)        as target_t
    from mine_production_daily
   group by 1, 2
), scored as (
  select d.*,
         avg(produced_t)    over w as trailing_mean,
         stddev(produced_t) over w as trailing_sd,
         count(*)           over w as trailing_days
    from daily d
  window w as (partition by mine_id order by production_date
               rows between 30 preceding and 1 preceding)
)
select mine_id, production_date, produced_t, target_t,
       round(trailing_mean, 1) as trailing_mean,
       round(trailing_sd, 1)   as trailing_sd,
       case when trailing_days >= 7 and trailing_sd > 0
            then round((produced_t - trailing_mean) / trailing_sd, 2) end as z_score,
       (trailing_days >= 7 and trailing_sd > 0
        and abs((produced_t - trailing_mean) / trailing_sd) >= 2.5)     as is_anomaly,
       case when target_t > 0 then round(100 * produced_t / target_t, 1) end as pct_of_target
  from scored;
alter view production_anomaly_view set (security_invoker = true);
grant select on production_anomaly_view to authenticated;

-- ------------------------------------------------------------
-- 6. Environmental monitoring against statutory limits
-- ------------------------------------------------------------
create table if not exists env_limits (
    parameter   text primary key,
    medium      text not null,          -- Air | Water | Noise
    unit        text not null,
    min_value   numeric,
    max_value   numeric,
    basis       text not null
);

-- Sources: CPCB National Ambient Air Quality Standards 2009 (24-hour
-- values, industrial/residential area); EP Rules 1986 Schedule VI general
-- standards for discharge to inland surface water; Noise Pollution
-- (Regulation and Control) Rules 2000, industrial area.
insert into env_limits (parameter, medium, unit, min_value, max_value, basis) values
  ('PM10',            'Air',   'µg/m³', null, 100, 'NAAQS 2009, 24-hour'),
  ('PM2.5',           'Air',   'µg/m³', null, 60,  'NAAQS 2009, 24-hour'),
  ('SO2',             'Air',   'µg/m³', null, 80,  'NAAQS 2009, 24-hour'),
  ('NO2',             'Air',   'µg/m³', null, 80,  'NAAQS 2009, 24-hour'),
  ('Discharge pH',    'Water', 'pH',    5.5,  9.0, 'EP Rules 1986, Sch. VI, inland surface water'),
  ('Discharge TSS',   'Water', 'mg/L',  null, 100, 'EP Rules 1986, Sch. VI, inland surface water'),
  ('Oil & grease',    'Water', 'mg/L',  null, 10,  'EP Rules 1986, Sch. VI, inland surface water'),
  ('Noise (day)',     'Noise', 'dB(A)', null, 75,  'Noise Rules 2000, industrial area, day'),
  ('Noise (night)',   'Noise', 'dB(A)', null, 70,  'Noise Rules 2000, industrial area, night')
on conflict (parameter) do nothing;

alter table env_limits enable row level security;
drop policy if exists "Signed-in read" on env_limits;
create policy "Signed-in read" on env_limits for select using (auth.uid() is not null);
drop policy if exists "Corporate manage" on env_limits;
create policy "Corporate manage" on env_limits for all
  using (auth_role() in ('corporate_admin','admin'))
  with check (auth_role() in ('corporate_admin','admin'));

create table if not exists env_readings (
    reading_id       uuid primary key default uuid_generate_v4(),
    mine_id          uuid references mines(mine_id) not null,
    reading_date     date not null,
    parameter        text references env_limits(parameter) not null,
    value            numeric not null,
    station_label    text,
    latitude         numeric(9,6),
    longitude        numeric(9,6),
    limit_min        numeric,
    limit_max        numeric,
    exceeds_limit    boolean,
    entered_by       uuid references user_profiles(profile_id),
    is_synthetic     boolean default false,
    created_at       timestamptz default now()
);
create index if not exists idx_env_mine_date on env_readings(mine_id, reading_date desc);

create or replace function env_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare l env_limits;
begin
  if auth.uid() is not null then
    new.entered_by := auth_profile_id();
    new.is_synthetic := false;
    if new.reading_date > current_date then
      raise exception 'A reading cannot be dated in the future.';
    end if;
  end if;
  select * into l from env_limits where parameter = new.parameter;
  -- The limit is copied onto the reading, so a later change to a standard
  -- does not silently rewrite whether a past reading was a breach.
  new.limit_min := l.min_value;
  new.limit_max := l.max_value;
  new.exceeds_limit := (l.max_value is not null and new.value > l.max_value)
                    or (l.min_value is not null and new.value < l.min_value);
  return new;
end $$;

drop trigger if exists trg_env_before_insert on env_readings;
create trigger trg_env_before_insert
  before insert on env_readings
  for each row execute function env_before_insert();

create or replace function env_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.exceeds_limit then
    perform raise_alert('mine_official', new.mine_id, 'environment', 'High',
      mine_label(new.mine_id) || ': ' || new.parameter || ' above statutory limit',
      new.parameter || ' measured ' || new.value
        || coalesce(' at ' || new.station_label, '') || ' on ' || new.reading_date
        || ' against a limit of '
        || coalesce(new.limit_max::text, '') || coalesce(' (min ' || new.limit_min || ')', '') || '.',
      'env_readings', new.reading_id::text, new.reading_date + 7);
  end if;
  return null;
end $$;

drop trigger if exists trg_env_after_insert on env_readings;
create trigger trg_env_after_insert
  after insert on env_readings
  for each row execute function env_after_insert();

alter table env_readings enable row level security;

drop policy if exists "Read env scoped" on env_readings;
create policy "Read env scoped" on env_readings
  for select using (is_oversight() or mine_id = auth_mine_id());

-- Readings are append-only for users: a wrong value is corrected by
-- entering the right one, so a breach cannot be quietly edited away.
drop policy if exists "Record env at own mine" on env_readings;
create policy "Record env at own mine" on env_readings
  for insert with check (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() in ('mine_official','inspector') and mine_id = auth_mine_id())
  );

-- ------------------------------------------------------------
-- 7. Evidence storage (Supabase Storage)
--
-- Private bucket. Files live under <mine_id>/..., and the folder is what
-- the policies check: you can read and add evidence for your own mine
-- only. Nobody can overwrite or delete evidence through the API.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, 10485760,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

drop policy if exists "Evidence read scoped" on storage.objects;
create policy "Evidence read scoped" on storage.objects
  for select using (
    bucket_id = 'evidence' and auth.uid() is not null and (
      public.is_oversight()
      or (storage.foldername(name))[1] = public.auth_mine_id()::text
    )
  );

drop policy if exists "Evidence upload scoped" on storage.objects;
create policy "Evidence upload scoped" on storage.objects
  for insert with check (
    bucket_id = 'evidence' and auth.uid() is not null and (
      public.auth_role() in ('corporate_admin','admin')
      or (storage.foldername(name))[1] = public.auth_mine_id()::text
    )
  );

alter table contractor_compliance add column if not exists document_url text;

-- contractor_compliance_view (migration 02) selects cc.*, and Postgres
-- expands * when a view is CREATED -- a column added later never appears.
-- Rebuilt so the document link reaches the dashboards; security_invoker
-- and the grant are re-applied because a new view starts without them.
drop view if exists contractor_compliance_view;
create view contractor_compliance_view as
select cc.*,
       c.contractor_name,
       c.mine_id,
       c.subsidiary_id,
       case
         when cc.valid_until is null                                    then 'Missing'
         when cc.valid_until < current_date                             then 'Expired'
         when cc.valid_until < current_date + interval '30 days'        then 'Expiring'
         else 'Valid'
       end                                                              as computed_status,
       (cc.valid_until - current_date)                                  as days_to_expiry
  from contractor_compliance cc
  join contractors c on c.contractor_id = cc.contractor_id;
alter view contractor_compliance_view set (security_invoker = true);
grant select on contractor_compliance_view to authenticated;

-- Completing a statutory obligation can now carry its proof.
alter table compliance_tracking add column if not exists evidence_url text;

-- ------------------------------------------------------------
-- 8. Database-level audit trail
--
-- Until now only the two backend endpoints wrote audit entries, so every
-- change made directly through the API -- closing a grievance, answering
-- a risk flag, blacklisting a contractor -- left no trace. These triggers
-- record the change itself, with the actor taken from the session.
--
-- TG_ARGV[0] is the primary key column. TG_ARGV[1], if given, lists
-- columns to redact: a grievance's text is private to the worker and the
-- mine, and must not surface in a trail the regulator reads.
-- ------------------------------------------------------------
create or replace function audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pk        text := tg_argv[0];
  redact    text[] := case when tg_nargs > 1 then string_to_array(tg_argv[1], ',') else '{}' end;
  old_j     jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  new_j     jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  details   jsonb;
  mine      text;
begin
  -- Bulk demo data loaded by the seed scripts is not a governance event;
  -- recording it would bury real actions under thousands of seed rows.
  if auth.uid() is null
     and coalesce((coalesce(new_j, old_j) ->> 'is_synthetic')::boolean, false) then
    return null;
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key,
             case when n.key = any(redact) then to_jsonb('[redacted]'::text)
                  else jsonb_build_object('from', o.value, 'to', n.value) end)
      into details
      from jsonb_each(new_j) n
      join jsonb_each(old_j) o using (key)
     where n.value is distinct from o.value;
    if details is null then return null; end if;     -- nothing actually changed
  else
    details := coalesce(new_j, old_j) - redact;
  end if;

  mine := coalesce(new_j, old_j) ->> 'mine_id';
  if mine is not null then
    details := details || jsonb_build_object('mine_id', mine);
  end if;

  insert into audit_log (actor_uid, action, table_affected, record_id, details)
  values (auth.uid(),
          lower(tg_op) || ' ' || tg_table_name,
          tg_table_name,
          coalesce(new_j, old_j) ->> pk,
          details);
  return null;
end $$;

do $$
declare
  spec text[];
begin
  foreach spec slice 1 in array array[
    -- table,                  pk column,        ops,                        redact
    array['geo_inspections',       'inspection_id', 'insert or update',        ''],
    array['incidents',             'incident_id',   'insert or update',        ''],
    array['attendance_records',    'record_id',     'insert or update',        ''],
    array['mine_production_daily', 'record_id',     'insert or update',        ''],
    array['env_readings',          'reading_id',    'insert',                  ''],
    array['grievances',            'grievance_id',  'insert or update',        'description,resolution_note'],
    array['contractors',           'contractor_id', 'insert or update',        ''],
    array['contractor_compliance', 'record_id',     'insert or update or delete', ''],
    array['user_profiles',         'profile_id',    'insert or update or delete', '']
  ] loop
    execute format('drop trigger if exists trg_audit_%s on %I', spec[1], spec[1]);
    execute format(
      'create trigger trg_audit_%s after %s on %I for each row execute function audit_row_change(%L%s)',
      spec[1], spec[3], spec[1], spec[2],
      case when spec[4] = '' then '' else format(', %L', spec[4]) end);
  end loop;
end $$;

-- Risk flags are re-scored by the analytics job on every run; only the
-- mine's RESPONSE is a governance event worth recording.
drop trigger if exists trg_audit_ai_risk_flags on ai_risk_flags;
create trigger trg_audit_ai_risk_flags
  after update on ai_risk_flags
  for each row
  when (old.response_status is distinct from new.response_status
        or old.response_note is distinct from new.response_note)
  execute function audit_row_change('flag_id');

-- Email notification bookkeeping for alerts_engine.py: an alert is
-- emailed once, and this records when.
alter table alerts add column if not exists notified_at timestamptz;

-- Realtime: stream new alerts to open dashboards the moment they are
-- raised (e.g. an incident reported at the face). Supabase Realtime
-- respects RLS, so each user receives only alerts they may read.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and tablename = 'alerts') then
    execute 'alter publication supabase_realtime add table alerts';
  end if;
end $$;

-- ============================================================
-- END OF MIGRATION 07
-- ============================================================
