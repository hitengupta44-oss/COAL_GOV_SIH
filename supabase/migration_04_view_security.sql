-- ============================================================
-- Migration 04 — close an RLS bypass in the views
--
-- WHY THIS MATTERS
--
-- A plain Postgres view executes with the permissions of the view's
-- OWNER, not the person querying it. The owner here is the superuser that
-- ran the migrations, and superusers bypass row level security. So every
-- view added in migrations 02 and 03 was handing back ALL rows to ANY
-- signed-in user, regardless of the policies on the underlying tables.
--
-- Confirmed by testing: a worker querying grievance_status_view could
-- read a grievance filed by someone else at a different mine, even though
-- querying the grievances table directly correctly returned only their
-- own. The policies were right; the views quietly went around them.
--
-- `security_invoker = true` (PostgreSQL 15+) makes a view run as the
-- caller instead, so RLS applies exactly as it does on the table. Every
-- view in this project reads RLS-protected data, so all of them need it.
--
-- Views also need an explicit SELECT grant: permission on the underlying
-- table does not carry across. Without it the dashboards fail outright
-- with "permission denied for view".
--
-- Run in the Supabase SQL editor after migration_03_alerts.sql.
-- ============================================================

alter view grievance_status_view       set (security_invoker = true);
alter view contractor_compliance_view  set (security_invoker = true);
alter view contractor_register_view    set (security_invoker = true);
alter view alert_escalation_view       set (security_invoker = true);

grant select on grievance_status_view       to anon, authenticated;
grant select on contractor_compliance_view  to anon, authenticated;
grant select on contractor_register_view    to anon, authenticated;
grant select on alert_escalation_view       to anon, authenticated;

-- contractors has a read policy but contractor_compliance_view joins it,
-- so make sure the base table is covered too. Idempotent: dropped first.
drop policy if exists "Read scoped by mine" on contractors;
create policy "Read scoped by mine" on contractors
  for select using (
    auth_role() in ('corporate_admin','regulator','admin')
    or mine_id = auth_mine_id()
  );

-- ------------------------------------------------------------
-- Verify after running. As a worker, these two numbers must match:
--
--   select count(*) from grievances;
--   select count(*) from grievance_status_view;
--
-- If the view returns more, security_invoker did not take effect and the
-- bypass is still open.
-- ------------------------------------------------------------

-- ============================================================
-- END OF MIGRATION 04
-- ============================================================
