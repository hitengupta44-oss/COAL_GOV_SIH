-- ============================================================
-- Migration 13 — roof and side falls need a DGMS notice
--
-- The report form treated a roof/side fall as serious, and the database
-- gave it High severity, but it was not on the list of incidents that
-- need a statutory notice to DGMS -- so a roof fall could be closed with
-- no notice on record. It now needs one, like a serious injury, fire or
-- inundation. Open roof-fall incidents already on record are brought
-- under the same rule (their 24-hour notice deadline counts from when
-- they occurred); closed ones are left as they were closed.
--
-- Run after migration_12_real_monitoring.sql. Safe to re-run.
-- ============================================================

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
  -- Act 1952, s.23). Roof and side falls are included (migration 13): they
  -- are the commonest cause of serious accidents in coal mines, and the
  -- report form already treats them as serious. The 24-hour window here is the platform's working
  -- deadline -- set it to match your statutory form and SOP.
  new.notifiable := new.incident_type in
    ('Fatal Accident','Serious Injury','Dangerous Occurrence','Fire','Inundation','Roof/Side Fall')
    or coalesce(new.persons_killed,0) > 0;
  new.dgms_notice_due_at := case when new.notifiable then new.occurred_at + interval '24 hours' end;

  select * into g from geofence_check(new.mine_id, new.latitude, new.longitude);
  new.distance_from_mine_m := g.distance_m;
  new.within_geofence      := g.within;
  return new;
end $$;


update incidents
   set notifiable = true,
       dgms_notice_due_at = occurred_at + interval '24 hours'
 where incident_type = 'Roof/Side Fall'
   and not coalesce(notifiable, false)
   and coalesce(status, '') <> 'Closed';
