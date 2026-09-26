-- ============================================================
-- Migration 06 — row level security on every table
--
-- WHY THIS EXISTS
--
-- schema.sql enabled RLS on only four tables and migrations 02-05 added
-- three more. Fourteen tables had it switched off, including grievances,
-- contractors and audit_log. In Supabase a public table without RLS is
-- readable AND writable by anyone holding the anon key -- and the anon key
-- ships inside the browser bundle. So anyone could rewrite a grievance,
-- flip a blacklist, or delete rows from the audit trail the regulator
-- relies on. The contractor policies from migrations 04/05 did nothing at
-- all, because a policy only applies once RLS is enabled on its table.
--
-- After this migration every table in `public` has RLS on, and every
-- write path is covered by an explicit policy.
--
-- Run in the Supabase SQL editor after migration_05_flag_response.sql.
-- Safe to re-run.
-- ============================================================

-- The caller's own profile_id. Several policies need it; a SECURITY
-- DEFINER helper avoids repeating a subquery against user_profiles (and
-- the policy recursion that can cause).
create or replace function auth_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
    select profile_id from user_profiles where auth_uid = auth.uid()
$$;

create or replace function is_oversight()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(auth_role() in ('corporate_admin','regulator','admin'), false)
$$;

-- ------------------------------------------------------------
-- 1. Switch RLS on everywhere it was off
-- ------------------------------------------------------------
alter table subsidiaries               enable row level security;
alter table production_records         enable row level security;
alter table accidents                  enable row level security;
alter table statutory_compliance_items enable row level security;
alter table dgms_inspection_stats      enable row level security;
alter table dgms_violation_categories  enable row level security;
alter table permissions_exemptions     enable row level security;
alter table air_quality_records        enable row level security;
alter table water_quality_records      enable row level security;
alter table contractors                enable row level security;
alter table attendance_records         enable row level security;
alter table grievances                 enable row level security;
alter table audit_log                  enable row level security;

-- ------------------------------------------------------------
-- 2. Reference and published data: any signed-in user may read,
--    only corporate/admin may change it.
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'subsidiaries','statutory_compliance_items','dgms_inspection_stats',
    'dgms_violation_categories','permissions_exemptions','accidents',
    'production_records','air_quality_records','water_quality_records'
  ] loop
    execute format('drop policy if exists "Signed-in read" on %I', t);
    execute format('create policy "Signed-in read" on %I for select using (auth.uid() is not null)', t);
    execute format('drop policy if exists "Corporate manage" on %I', t);
    execute format($p$create policy "Corporate manage" on %I for all
                     using (auth_role() in ('corporate_admin','admin'))
                     with check (auth_role() in ('corporate_admin','admin'))$p$, t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 3. Grievances
--    Oversight sees all. The mine official sees their own mine's. A
--    worker (or anyone else) sees only what they filed themselves --
--    a grievance about harassment should not be readable by colleagues.
-- ------------------------------------------------------------
drop policy if exists "Read grievances scoped" on grievances;
create policy "Read grievances scoped" on grievances
  for select using (
    is_oversight()
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
    or filed_by = auth_profile_id()
  );

-- Anyone attached to a mine can file, but only at their own mine and only
-- under their own name.
drop policy if exists "File own grievance" on grievances;
create policy "File own grievance" on grievances
  for insert with check (
    auth_role() in ('worker','inspector','contractor_manager','mine_official')
    and mine_id = auth_mine_id()
    and filed_by = auth_profile_id()
  );

-- The update policy from migration 02 let the person who filed a
-- grievance update ANY column of it -- including marking it Resolved
-- themselves. That is replaced: the filer can no longer update at all
-- (they can file a new one), and the mine official / corporate keep the
-- ability to act on it. Nobody deletes grievances.
drop policy if exists "Update grievances scoped" on grievances;
create policy "Update grievances scoped" on grievances
  for update using (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
  );

-- ------------------------------------------------------------
-- 4. Contractors
--    Read and update policies were written in migrations 04/05 but were
--    inert until now. Adding contractors was not possible at all.
-- ------------------------------------------------------------
drop policy if exists "Add contractors scoped" on contractors;
create policy "Add contractors scoped" on contractors
  for insert with check (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() in ('contractor_manager','mine_official') and mine_id = auth_mine_id())
  );

-- Contractor documents: the migration-02 policy let ANY contractor
-- manager change documents at ANY mine. Scoped to their own mine now.
drop policy if exists "Manage contractor compliance" on contractor_compliance;
create policy "Manage contractor compliance" on contractor_compliance
  for all using (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() in ('contractor_manager','mine_official') and exists (
          select 1 from contractors c
           where c.contractor_id = contractor_compliance.contractor_id
             and c.mine_id = auth_mine_id()))
  )
  with check (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() in ('contractor_manager','mine_official') and exists (
          select 1 from contractors c
           where c.contractor_id = contractor_compliance.contractor_id
             and c.mine_id = auth_mine_id()))
  );

-- ------------------------------------------------------------
-- 5. Shift attendance summaries
-- ------------------------------------------------------------
drop policy if exists "Read attendance scoped" on attendance_records;
create policy "Read attendance scoped" on attendance_records
  for select using (is_oversight() or mine_id = auth_mine_id());

drop policy if exists "Record attendance scoped" on attendance_records;
create policy "Record attendance scoped" on attendance_records
  for insert with check (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
  );

drop policy if exists "Correct attendance scoped" on attendance_records;
create policy "Correct attendance scoped" on attendance_records
  for update using (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
  );

-- ------------------------------------------------------------
-- 6. Audit log: readable by oversight, writable by nobody through the API
--
-- Entries are written by the backend (service role) and by the SECURITY
-- DEFINER audit triggers added in migration 07. No client role gets an
-- insert, update or delete policy, so the table cannot be edited through
-- the API at all. Migration 08 adds the hash chain on top.
-- ------------------------------------------------------------
drop policy if exists "Oversight reads audit" on audit_log;
create policy "Oversight reads audit" on audit_log
  for select using (auth_role() in ('corporate_admin','regulator','admin'));

-- Belt and braces: even the service role and the table owner cannot
-- rewrite history. Corrections are made by appending, never by editing.
create or replace function audit_log_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists trg_audit_log_no_update on audit_log;
create trigger trg_audit_log_no_update
  before update or delete on audit_log
  for each row execute function audit_log_append_only();

drop trigger if exists trg_audit_log_no_truncate on audit_log;
create trigger trg_audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function audit_log_append_only();

-- ------------------------------------------------------------
-- 7. Alerts with no mine
--
-- Migration 03 let a role-addressed alert with a blank mine_id reach
-- EVERY holder of that role -- so an alert about a record whose mine was
-- never identified appeared on every mine official's dashboard as
-- "Unknown mine". Mine-attached roles now see only their own mine's
-- alerts; an alert with no mine reaches oversight roles only.
-- ------------------------------------------------------------
drop policy if exists "Read own alerts" on alerts;
create policy "Read own alerts" on alerts
  for select using (
    is_oversight()
    or recipient_id = auth_profile_id()
    or (recipient_role = auth_role() and mine_id is not null and mine_id = auth_mine_id())
  );

drop policy if exists "Acknowledge own alerts" on alerts;
create policy "Acknowledge own alerts" on alerts
  for update using (
    is_oversight()
    or recipient_id = auth_profile_id()
    or (recipient_role = auth_role() and mine_id is not null and mine_id = auth_mine_id())
  );

-- ------------------------------------------------------------
-- 8. Views: signed-in users only
--
-- Migration 04 granted SELECT on the views to `anon` as well. With
-- security_invoker the RLS on the base tables still applies, but there is
-- no reason for a logged-out visitor to reach them at all.
-- ------------------------------------------------------------
revoke select on grievance_status_view      from anon;
revoke select on contractor_compliance_view from anon;
revoke select on contractor_register_view   from anon;
revoke select on alert_escalation_view      from anon;
revoke select on risk_flag_view             from anon;

-- ------------------------------------------------------------
-- Verify: every row below should say `true`.
--
--   select relname, relrowsecurity
--     from pg_class
--    where relnamespace = 'public'::regnamespace and relkind = 'r'
--      and relname <> 'spatial_ref_sys'
--    order by relrowsecurity, relname;
--
-- (spatial_ref_sys belongs to the PostGIS extension and holds only public
-- coordinate-system definitions; Supabase's own advice is to leave it.)
-- ============================================================
-- END OF MIGRATION 06
-- ============================================================
