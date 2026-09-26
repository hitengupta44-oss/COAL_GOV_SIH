-- ============================================================
-- Migration 02 — grievance resolution workflow and contractor
-- compliance tracking.
--
-- Run this once in the Supabase SQL editor, after schema.sql.
-- Safe to re-run: every statement uses IF NOT EXISTS or an
-- equivalent guard.
-- ============================================================

-- ------------------------------------------------------------
-- 1. GRIEVANCE WORKFLOW
--
-- The table already had status, escalated and days_to_resolve, but
-- nothing recorded WHO acted, WHEN, or WHY -- so a grievance could be
-- marked Resolved with no account of what was done about it. For a
-- governance platform that record is the point: the resolution note is
-- the evidence, not the status flag.
-- ------------------------------------------------------------
alter table grievances add column if not exists assigned_to        uuid references user_profiles(profile_id);
alter table grievances add column if not exists resolution_note    text;
alter table grievances add column if not exists resolved_by        uuid references user_profiles(profile_id);
alter table grievances add column if not exists resolved_at        timestamptz;
alter table grievances add column if not exists escalated_at       timestamptz;
alter table grievances add column if not exists due_by             date;
alter table grievances add column if not exists priority           text;

-- Priority is constrained rather than free text so it can drive sorting
-- and colour without a lookup table.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'grievances_priority_check') then
    alter table grievances add constraint grievances_priority_check
      check (priority is null or priority in ('Low','Medium','High'));
  end if;
end $$;

-- Every grievance gets a response deadline. 14 days is the working
-- assumption here; change the interval if your SOP differs.
update grievances
   set due_by = date_filed + interval '14 days'
 where due_by is null and date_filed is not null;

-- A grievance past its deadline and still open is overdue. This view
-- exists so the dashboards and the alerts engine agree on one
-- definition rather than each re-deriving it.
create or replace view grievance_status_view as
select g.*,
       (g.status in ('In Progress','Escalated')
        and g.due_by is not null
        and g.due_by < current_date)                         as is_overdue,
       case when g.due_by is null then null
            else (g.due_by - current_date) end               as days_remaining
  from grievances g;

-- ------------------------------------------------------------
-- 2. CONTRACTOR COMPLIANCE
--
-- The register tracked contract dates and a blacklist flag, but not
-- whether a contractor's statutory documents are valid -- which is the
-- thing that actually stops them working on site. Safety training,
-- insurance, PF registration and licences all expire, and an expired
-- one is a compliance breach the moment their people are underground.
-- ------------------------------------------------------------
create table if not exists contractor_compliance (
    record_id        uuid primary key default uuid_generate_v4(),
    contractor_id    uuid references contractors(contractor_id) on delete cascade,
    document_type    text not null,
    reference_no     text,
    issued_on        date,
    valid_until      date,
    status           text default 'Valid',
    remarks          text,
    created_at       timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contractor_compliance_status_check') then
    alter table contractor_compliance add constraint contractor_compliance_status_check
      check (status in ('Valid','Expiring','Expired','Missing'));
  end if;
end $$;

create index if not exists idx_cc_contractor on contractor_compliance(contractor_id);
create index if not exists idx_cc_valid_until on contractor_compliance(valid_until);

-- Derived status, so nobody has to remember to run an update job for a
-- document to become "expired". 30 days is the warning window.
create or replace view contractor_compliance_view as
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

-- Contract expiry, same treatment: one definition both dashboards and
-- alerts read from.
create or replace view contractor_register_view as
select c.*,
       case
         when c.blacklisted                                             then 'Blacklisted'
         when c.contract_end is null                                    then 'No end date'
         when c.contract_end < current_date                             then 'Contract expired'
         when c.contract_end < current_date + interval '60 days'        then 'Expiring soon'
         else 'In force'
       end                                                              as contract_state,
       (c.contract_end - current_date)                                  as days_to_contract_end,
       (select count(*) from contractor_compliance cc
         where cc.contractor_id = c.contractor_id
           and (cc.valid_until is null or cc.valid_until < current_date))
                                                                        as expired_documents
  from contractors c;

-- ------------------------------------------------------------
-- 3. ROW LEVEL SECURITY for the new table
--
-- Same scoping rule as everything else: oversight roles see across
-- mines, mine-attached roles see their own site only.
-- ------------------------------------------------------------
alter table contractor_compliance enable row level security;

drop policy if exists "Read contractor compliance" on contractor_compliance;
create policy "Read contractor compliance" on contractor_compliance
  for select using (
    auth_role() in ('corporate_admin','regulator','admin')
    or exists (
      select 1 from contractors c
       where c.contractor_id = contractor_compliance.contractor_id
         and c.mine_id = auth_mine_id()
    )
  );

drop policy if exists "Manage contractor compliance" on contractor_compliance;
create policy "Manage contractor compliance" on contractor_compliance
  for all using (
    auth_role() in ('corporate_admin','admin','contractor_manager')
  );

-- Grievance update policy is widened so a mine official can record a
-- resolution, and so the person who filed it can add detail to their
-- own. Reading stays as previously defined.
drop policy if exists "Update grievances scoped" on grievances;
create policy "Update grievances scoped" on grievances
  for update using (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
    or filed_by = (select profile_id from user_profiles where auth_uid = auth.uid())
  );

-- ============================================================
-- END OF MIGRATION 02
-- ============================================================
