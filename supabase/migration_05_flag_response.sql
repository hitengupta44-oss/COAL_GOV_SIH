-- ============================================================
-- Migration 05 — let the people accountable for a mine respond
--
-- Two gaps this closes:
--
-- 1. RISK FLAGS were write-once. The scoring job raised them and nobody
--    could answer. A mine official could see "Recurring Violation, risk
--    1.0" against their site with no way to record that the underlying
--    problem was fixed, or that the classification was wrong. A flag
--    nobody can respond to is an accusation, not a governance signal --
--    and it also means the analytics never learn which flags were fair.
--
-- 2. BLACKLISTING was contractor-manager only, even though the mine
--    official is the person accountable for who is underground at their
--    site. They could see a contractor with lapsed safety training and
--    do nothing about it.
--
-- Run in the Supabase SQL editor after migration_04_view_security.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Response fields on risk flags
-- ------------------------------------------------------------
alter table ai_risk_flags add column if not exists response_status  text default 'Open';
alter table ai_risk_flags add column if not exists response_note    text;
alter table ai_risk_flags add column if not exists responded_by     uuid references user_profiles(profile_id);
alter table ai_risk_flags add column if not exists responded_at     timestamptz;

-- "Disputed" is deliberately a first-class outcome alongside "Addressed".
-- An operator who believes a flag is wrong needs somewhere to say so on
-- the record; without it the only way to clear a bad flag is to ignore
-- it, and the distinction between "fixed" and "never real" is lost.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_risk_flags_response_check') then
    alter table ai_risk_flags add constraint ai_risk_flags_response_check
      check (response_status in ('Open','Acknowledged','Addressed','Disputed'));
  end if;
end $$;

create index if not exists idx_risk_flag_mine on ai_risk_flags(mine_id, response_status);

-- ------------------------------------------------------------
-- 2. Row level security on risk flags
--
-- Reading stays open to any signed-in user (the map and the corporate
-- dashboard both plot flags across mines). Responding is restricted to
-- the mine's own official, or to corporate and admin.
-- ------------------------------------------------------------
alter table ai_risk_flags enable row level security;

drop policy if exists "Authenticated read" on ai_risk_flags;
create policy "Authenticated read" on ai_risk_flags
  for select using (auth.uid() is not null);

drop policy if exists "Respond to own mine flags" on ai_risk_flags;
create policy "Respond to own mine flags" on ai_risk_flags
  for update using (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
  );

-- Regulators are deliberately NOT given update here. Oversight that can
-- quietly clear its own findings is not oversight.

-- ------------------------------------------------------------
-- 3. Mine officials can manage contractors at their own site
-- ------------------------------------------------------------
drop policy if exists "Update contractors scoped" on contractors;
create policy "Update contractors scoped" on contractors
  for update using (
    auth_role() in ('corporate_admin','admin')
    or (auth_role() = 'contractor_manager' and mine_id = auth_mine_id())
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
  );

-- ------------------------------------------------------------
-- 4. Flags with their response state, for the dashboards.
--    security_invoker so RLS applies to the caller -- see migration 04
--    for why a plain view would bypass it entirely.
-- ------------------------------------------------------------
create or replace view risk_flag_view as
select f.*,
       m.mine_name,
       m.state,
       u.full_name as responded_by_name
  from ai_risk_flags f
  left join mines m on m.mine_id = f.mine_id
  left join user_profiles u on u.profile_id = f.responded_by;

alter view risk_flag_view set (security_invoker = true);
grant select on risk_flag_view to anon, authenticated;

-- ============================================================
-- END OF MIGRATION 05
-- ============================================================
