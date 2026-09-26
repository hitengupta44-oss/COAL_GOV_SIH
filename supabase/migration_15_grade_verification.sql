-- ============================================================
-- Migration 15 — coal dispatch grade verification (logistics)
--
-- Grade slippage -- coal billed at a higher grade than what actually
-- leaves the mine -- is a long-running dispute between coal companies and
-- their customers (power plants above all). This module lets an inspector
-- check a dispatch against the grade declared in the mine's records:
--
--   1. The mine records each dispatch: rake or truck, consignee, tonnes
--      and the DECLARED grade (G1-G17).
--   2. At the siding or weighbridge the inspector photographs the load and
--      records the result of the grade test -- GCV (kcal/kg), ash and
--      moisture -- from a field or laboratory test of the sample.
--   3. The database works out the ACTUAL grade from GCV using the Coal
--      Controller's official bands, compares it with the declared grade,
--      and reaches a verdict. Slippage alerts the mine at once, and
--      corporate and the regulator when it is two grades or more.
--   4. The photos are also screened by an AI vision model on the backend
--      for visible warning signs (stones and shale, excess fines, wet coal).
--      A photo cannot establish GCV, so without a test result the verdict
--      is at most "Lab test needed" -- never "slippage".
--   5. The mine accepts or disputes the finding with a written response.
--      Every check carries a SHA-256 fingerprint of its content, printed
--      on the report.
--
-- Run after migration_14_blockchain_anchor.sql. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Official grade bands (non-coking coal, by Gross Calorific Value)
-- ------------------------------------------------------------
create table if not exists coal_grade_bands (
    grade      text primary key,
    rank       int  not null unique,          -- 1 = G1 (best) ... 17 = G17
    gcv_min    int  not null,                 -- kcal/kg, inclusive
    gcv_max    int                            -- null for G1 (above 7000)
);
insert into coal_grade_bands (grade, rank, gcv_min, gcv_max) values
  ('G1', 1, 7001, null), ('G2', 2, 6701, 7000), ('G3', 3, 6401, 6700), ('G4', 4, 6101, 6400),
  ('G5', 5, 5801, 6100), ('G6', 6, 5501, 5800), ('G7', 7, 5201, 5500), ('G8', 8, 4901, 5200),
  ('G9', 9, 4601, 4900), ('G10', 10, 4301, 4600), ('G11', 11, 4001, 4300), ('G12', 12, 3701, 4000),
  ('G13', 13, 3401, 3700), ('G14', 14, 3101, 3400), ('G15', 15, 2801, 3100), ('G16', 16, 2501, 2800),
  ('G17', 17, 2201, 2500)
on conflict (grade) do nothing;
comment on table coal_grade_bands is
  'Non-coking coal grades by GCV (kcal/kg), Coal Controller''s Organisation / Ministry of Coal notification (2011).';
alter table coal_grade_bands enable row level security;
drop policy if exists "Signed-in read" on coal_grade_bands;
create policy "Signed-in read" on coal_grade_bands for select using (auth.uid() is not null);

-- GCV -> grade. Below 2201 kcal/kg the coal is ungraded.
create or replace function gcv_to_grade(p_gcv numeric)
returns text
language sql
stable
as $$
  select case when p_gcv is null then null
              when p_gcv < 2201 then 'Ungraded'
              else (select grade from coal_grade_bands
                     where p_gcv >= gcv_min and (gcv_max is null or p_gcv <= gcv_max)) end
$$;

create or replace function grade_rank(p_grade text)
returns int
language sql
stable
as $$
  select case when p_grade = 'Ungraded' then 18 else (select rank from coal_grade_bands where grade = p_grade) end
$$;

-- ------------------------------------------------------------
-- 1b. Official annual grade declarations
--
-- Every year each coal company declares, under rule 4(3)-(4) of the
-- Colliery Control (Amendment) Rules 2021, the grade of each mine's coal
-- and of each dispatch point (siding, silo, MGR, road sale), and files it
-- with the Coal Controller. These are loaded from the published orders
-- (e.g. MCL's declaration for 2025-26, dated 31.03.2025) by
-- load_declared_grades.py. mine_ids lists the mines whose coal the row
-- declares at mine level.
-- ------------------------------------------------------------
create table if not exists declared_grades (
    declared_grade_id serial primary key,
    subsidiary     text not null,
    fy             text not null,                 -- e.g. 2025-26
    area           text not null,
    dispatch_point text not null,
    point_type     text not null check (point_type in ('Mine', 'Siding', 'Silo', 'MGR', 'Road sale', 'Other')),
    seams          text,
    location       text not null default '',      -- a part of a siding, where the grade differs along it
    grade          text not null references coal_grade_bands(grade),
    provisional    boolean not null default false,
    mine_ids       uuid[] not null default '{}',
    source         text not null,
    unique (subsidiary, fy, area, dispatch_point, location)
);
alter table declared_grades enable row level security;
drop policy if exists "Signed-in read" on declared_grades;
create policy "Signed-in read" on declared_grades for select using (auth.uid() is not null);
drop policy if exists "Corporate manage" on declared_grades;
create policy "Corporate manage" on declared_grades for all
  using (auth_role() in ('corporate_admin', 'admin'))
  with check (auth_role() in ('corporate_admin', 'admin'));

-- Each mine's official grade: the latest year's declaration naming it.
create or replace function official_grade_of(p_mine uuid)
returns table (grade text, fy text, provisional boolean, source text)
language sql
stable
security definer
set search_path = public
as $$
  select g.grade, g.fy, g.provisional, g.source
    from declared_grades g
   where p_mine = any (g.mine_ids)
   order by g.fy desc, (g.point_type = 'Mine') desc, g.declared_grade_id
   limit 1
$$;

-- ------------------------------------------------------------
-- 2. Dispatches, as recorded by the mine
-- ------------------------------------------------------------
create table if not exists coal_dispatches (
    dispatch_id     uuid primary key default uuid_generate_v4(),
    mine_id         uuid not null references mines(mine_id),
    dispatch_date   date not null,
    mode            text not null check (mode in ('Rail', 'Road', 'Conveyor / MGR')),
    vehicle_ref     text not null,            -- rake number, truck registration, etc.
    consignee       text not null,
    quantity_t      numeric(12,2) not null check (quantity_t > 0),
    declared_grade  text not null references coal_grade_bands(grade),
    remarks         text,
    entered_by      uuid references user_profiles(profile_id),
    is_synthetic    boolean default false,
    created_at      timestamptz default now()
);
create index if not exists idx_dispatch_mine_date on coal_dispatches(mine_id, dispatch_date desc);
alter table coal_dispatches add column if not exists dispatch_point text;

-- Billing above the official grade: a dispatch declared at a better grade
-- than the mine's official annual grade is flagged to corporate at once --
-- before any sample is taken.
create or replace function dispatches_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare o record;
begin
  if new.is_synthetic then return null; end if;
  select * into o from official_grade_of(new.mine_id);
  if o.grade is not null and grade_rank(new.declared_grade) < grade_rank(o.grade) then
    perform raise_alert('corporate_admin', new.mine_id, 'logistics', 'High',
      mine_label(new.mine_id) || ': dispatch declared ' || new.declared_grade || ', above the official grade ' || o.grade,
      new.mode || ' ' || new.vehicle_ref || ' to ' || new.consignee || ' on ' || new.dispatch_date || ', '
        || new.quantity_t || ' t. The mine''s declared grade for ' || o.fy || ' is ' || o.grade
        || case when o.provisional then ' (provisional)' else '' end || ' (' || o.source || ').',
      'coal_dispatches', new.dispatch_id::text, (now() + interval '7 days')::date);
  end if;
  return null;
end $$;
drop trigger if exists trg_dispatches_after_insert on coal_dispatches;
create trigger trg_dispatches_after_insert after insert on coal_dispatches
  for each row execute function dispatches_after_insert();

create or replace function dispatches_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.entered_by := auth_profile_id();
    new.is_synthetic := false;
    if new.dispatch_date > current_date then
      raise exception 'A dispatch cannot be dated in the future.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_dispatches_before_insert on coal_dispatches;
create trigger trg_dispatches_before_insert before insert on coal_dispatches
  for each row execute function dispatches_before_insert();

-- The declared grade is what the customer is billed for: once recorded it
-- cannot be changed, and a dispatch cannot be deleted.
create or replace function dispatches_immutable()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then raise exception 'A dispatch record cannot be deleted.'; end if;
  if (new.mine_id, new.dispatch_date, new.mode, new.vehicle_ref, new.consignee, new.quantity_t, new.declared_grade)
     is distinct from (old.mine_id, old.dispatch_date, old.mode, old.vehicle_ref, old.consignee, old.quantity_t, old.declared_grade) then
    raise exception 'A recorded dispatch cannot be changed. Record a correction as a new dispatch with remarks.';
  end if;
  return new;
end $$;
drop trigger if exists trg_dispatches_immutable on coal_dispatches;
create trigger trg_dispatches_immutable before update or delete on coal_dispatches
  for each row execute function dispatches_immutable();

alter table coal_dispatches enable row level security;
drop policy if exists "Read dispatches scoped" on coal_dispatches;
create policy "Read dispatches scoped" on coal_dispatches
  for select using (is_oversight() or (mine_id = auth_mine_id()
                    and auth_role() in ('mine_official', 'inspector', 'contractor_manager')));
drop policy if exists "Record dispatches at own mine" on coal_dispatches;
create policy "Record dispatches at own mine" on coal_dispatches
  for insert with check (
    auth_role() in ('corporate_admin', 'admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id()));
drop policy if exists "Remarks on dispatches" on coal_dispatches;
create policy "Remarks on dispatches" on coal_dispatches
  for update using (
    auth_role() in ('corporate_admin', 'admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id()));

-- ------------------------------------------------------------
-- 3. Grade checks, by the inspector
-- ------------------------------------------------------------
create table if not exists grade_checks (
    check_id          uuid primary key default uuid_generate_v4(),
    dispatch_id       uuid not null references coal_dispatches(dispatch_id),
    mine_id           uuid references mines(mine_id),          -- copied from the dispatch
    inspector_id      uuid references user_profiles(profile_id),
    checked_at        timestamptz default now(),
    latitude          numeric(9,6),
    longitude         numeric(9,6),
    distance_from_mine_m numeric,
    within_geofence   boolean,
    photo_paths       text[] not null default '{}',
    sample_ref        text,
    test_method       text check (test_method in ('Field test', 'Laboratory (third party)', 'Laboratory (mine)')),
    gcv_kcal_kg       int check (gcv_kcal_kg between 1000 and 8500),
    ash_pct           numeric(5,2) check (ash_pct between 0 and 80),
    moisture_pct      numeric(5,2) check (moisture_pct between 0 and 60),
    notes             text,
    -- AI photo screening, written only by the backend (service role)
    ai_assessment     jsonb,
    ai_model          text,
    ai_at             timestamptz,
    -- Worked out by the database
    declared_grade    text,
    assessed_grade    text,
    grade_gap         int,          -- positive = worse than declared
    verdict           text check (verdict in ('Matches declared grade', 'Better than declared',
                                               'Grade slippage', 'Lab test needed', 'Visual check only')),
    report_hash       text,
    -- The mine's answer
    status            text not null default 'Open' check (status in ('Open', 'Accepted by mine', 'Disputed by mine', 'Closed')),
    mine_answer       text check (mine_answer in ('Accepted', 'Disputed')),   -- kept after closing
    mine_response     text,
    responded_by      uuid references user_profiles(profile_id),
    responded_at      timestamptz,
    closed_by         uuid references user_profiles(profile_id),
    closed_at         timestamptz,
    is_synthetic      boolean default false,
    created_at        timestamptz default now()
);
create index if not exists idx_grade_checks_mine on grade_checks(mine_id, checked_at desc);
create index if not exists idx_grade_checks_dispatch on grade_checks(dispatch_id);

-- Verdict, fingerprint. Called whenever the facts change (insert, and when
-- the backend adds the AI screening).
create or replace function grade_check_evaluate(g grade_checks)
returns grade_checks
language plpgsql
stable
set search_path = public
as $$
declare d coal_dispatches;
begin
  select * into d from coal_dispatches where dispatch_id = g.dispatch_id;
  g.declared_grade := d.declared_grade;
  g.assessed_grade := gcv_to_grade(g.gcv_kcal_kg);
  g.grade_gap := case when g.assessed_grade is null then null
                      else grade_rank(g.assessed_grade) - grade_rank(d.declared_grade) end;
  g.verdict := case
    when g.grade_gap is null then
      case when coalesce(g.ai_assessment ->> 'consistent_with_declared', '') = 'no'
           then 'Lab test needed' else 'Visual check only' end
    when g.grade_gap > 0 then 'Grade slippage'
    when g.grade_gap < 0 then 'Better than declared'
    else 'Matches declared grade' end;
  -- The fingerprint covers what the report asserts: the dispatch as
  -- recorded, what was measured, the evidence and the verdict.
  g.report_hash := encode(sha256(convert_to(jsonb_build_object(
      'check_id', g.check_id, 'dispatch_id', d.dispatch_id, 'mine_id', d.mine_id,
      'dispatch_date', d.dispatch_date, 'vehicle_ref', d.vehicle_ref, 'consignee', d.consignee,
      'quantity_t', d.quantity_t, 'declared_grade', d.declared_grade,
      'checked_at', g.checked_at, 'inspector_id', g.inspector_id,
      'latitude', g.latitude, 'longitude', g.longitude, 'photos', g.photo_paths,
      'sample_ref', g.sample_ref, 'test_method', g.test_method, 'gcv_kcal_kg', g.gcv_kcal_kg,
      'ash_pct', g.ash_pct, 'moisture_pct', g.moisture_pct,
      'ai_assessment', g.ai_assessment, 'assessed_grade', g.assessed_grade,
      'grade_gap', g.grade_gap, 'verdict', g.verdict)::text, 'UTF8')), 'hex');
  return g;
end $$;

create or replace function grade_checks_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare d coal_dispatches; geo record;
begin
  select * into d from coal_dispatches where dispatch_id = new.dispatch_id;
  if d.dispatch_id is null then
    raise exception 'Unknown dispatch.';
  end if;
  new.mine_id := d.mine_id;
  if auth.uid() is not null then
    if auth_role() not in ('inspector', 'corporate_admin', 'admin') then
      raise exception 'Grade checks are recorded by inspectors.';
    end if;
    if auth_role() = 'inspector' and d.mine_id is distinct from auth_mine_id() then
      raise exception 'You can check dispatches from your own mine only.';
    end if;
    new.inspector_id := auth_profile_id();
    new.checked_at := now();
    new.is_synthetic := false;
    new.status := 'Open';
    -- The AI screening is added by the backend, never by the inspector.
    new.ai_assessment := null; new.ai_model := null; new.ai_at := null;
    new.mine_answer := null; new.mine_response := null; new.responded_by := null; new.responded_at := null;
    new.closed_by := null; new.closed_at := null;
  end if;
  if coalesce(array_length(new.photo_paths, 1), 0) = 0 then
    raise exception 'Add at least one photo of the load.';
  end if;
  if new.gcv_kcal_kg is not null and new.test_method is null then
    raise exception 'Say how the GCV was measured (field or laboratory test).';
  end if;
  select * into geo from geofence_check(new.mine_id, new.latitude, new.longitude);
  new.distance_from_mine_m := geo.distance_m;
  new.within_geofence := geo.within;
  new := grade_check_evaluate(new);
  return new;
end $$;
drop trigger if exists trg_grade_checks_before_insert on grade_checks;
create trigger trg_grade_checks_before_insert before insert on grade_checks
  for each row execute function grade_checks_before_insert();

-- After filing: the measurements and evidence are fixed. The mine may
-- accept or dispute (with a reason); corporate closes. The backend (no
-- auth.uid) may add the AI screening, which re-evaluates the verdict.
create or replace function grade_checks_before_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r text := auth_role();
begin
  if (new.dispatch_id, new.mine_id, new.inspector_id, new.checked_at, new.latitude, new.longitude,
      new.photo_paths, new.sample_ref, new.test_method, new.gcv_kcal_kg, new.ash_pct, new.moisture_pct, new.notes)
     is distinct from
     (old.dispatch_id, old.mine_id, old.inspector_id, old.checked_at, old.latitude, old.longitude,
      old.photo_paths, old.sample_ref, old.test_method, old.gcv_kcal_kg, old.ash_pct, old.moisture_pct, old.notes) then
    raise exception 'A filed grade check cannot be edited. Record a new check instead.';
  end if;

  if auth.uid() is null then
    -- Backend adding the AI screening.
    return grade_check_evaluate(new);
  end if;

  if (new.ai_assessment, new.ai_model, new.ai_at) is distinct from (old.ai_assessment, old.ai_model, old.ai_at) then
    raise exception 'The AI screening is recorded by the system only.';
  end if;
  if old.status = 'Closed' then
    raise exception 'This grade check is closed.';
  end if;

  if new.status in ('Accepted by mine', 'Disputed by mine') and new.status is distinct from old.status then
    if not (r = 'mine_official' and old.mine_id = auth_mine_id()) then
      raise exception 'Only the mine official answers a grade check.';
    end if;
    if old.status <> 'Open' then
      raise exception 'The mine has already answered this check.';
    end if;
    if coalesce(btrim(new.mine_response), '') = '' then
      raise exception 'Write the mine''s response: what was found, or why the finding is disputed.';
    end if;
    new.mine_answer := case when new.status = 'Accepted by mine' then 'Accepted' else 'Disputed' end;
    new.responded_by := auth_profile_id();
    new.responded_at := now();
  elsif new.status = 'Closed' and old.status <> 'Closed' then
    if (new.mine_response, new.mine_answer) is distinct from (old.mine_response, old.mine_answer) then
      raise exception 'Closing does not change the mine''s response.';
    end if;
    if r not in ('corporate_admin', 'admin') then
      raise exception 'Corporate management closes a grade check.';
    end if;
    new.closed_by := auth_profile_id();
    new.closed_at := now();
  elsif new.status is distinct from old.status then
    raise exception 'Cannot move a grade check from % to %.', old.status, new.status;
  elsif (new.mine_response, new.mine_answer) is distinct from (old.mine_response, old.mine_answer) then
    raise exception 'The mine''s response cannot be changed once given.';
  end if;
  new.report_hash := old.report_hash; new.verdict := old.verdict;
  new.assessed_grade := old.assessed_grade; new.grade_gap := old.grade_gap; new.declared_grade := old.declared_grade;
  return new;
end $$;
drop trigger if exists trg_grade_checks_before_update on grade_checks;
create trigger trg_grade_checks_before_update before update on grade_checks
  for each row execute function grade_checks_before_update();

-- Alerts: slippage reaches the mine at once; two grades or more also
-- reaches corporate and the regulator. A photo-only red flag asks the
-- mine official for a laboratory test.
create or replace function grade_checks_after_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d coal_dispatches;
  t text; b text;
begin
  if tg_op = 'UPDATE' and new.verdict is not distinct from old.verdict then
    return null;
  end if;
  select * into d from coal_dispatches where dispatch_id = new.dispatch_id;
  if new.verdict = 'Grade slippage' then
    t := mine_label(new.mine_id) || ': coal dispatched ' || new.grade_gap || ' grade'
         || case when new.grade_gap > 1 then 's' else '' end || ' below the declared grade';
    b := d.mode || ' ' || d.vehicle_ref || ' to ' || d.consignee || ' on ' || d.dispatch_date
         || ', ' || d.quantity_t || ' t declared ' || d.declared_grade || '; tested '
         || new.gcv_kcal_kg || ' kcal/kg = ' || new.assessed_grade || ' (' || coalesce(new.test_method, 'test') || ').';
    perform raise_alert('mine_official', new.mine_id, 'logistics', case when new.grade_gap >= 2 then 'Critical' else 'High' end,
                        t, b, 'grade_checks', new.check_id::text, (now() + interval '7 days')::date);
    if new.grade_gap >= 2 then
      perform raise_alert('corporate_admin', new.mine_id, 'logistics', 'Critical', t, b,
                          'grade_checks', new.check_id::text || ':corporate', (now() + interval '7 days')::date);
      perform raise_alert('regulator', new.mine_id, 'logistics', 'High', t, b,
                          'grade_checks', new.check_id::text || ':regulator', null);
    end if;
  elsif new.verdict = 'Lab test needed' then
    perform raise_alert('mine_official', new.mine_id, 'logistics', 'Medium',
      mine_label(new.mine_id) || ': dispatch ' || d.vehicle_ref || ' needs a laboratory grade test',
      'Photo screening found signs inconsistent with the declared grade ' || d.declared_grade
        || coalesce(': ' || (new.ai_assessment ->> 'summary'), '.') || ' Send a sample for GCV analysis.',
      'grade_checks', new.check_id::text, (now() + interval '7 days')::date);
  end if;
  return null;
end $$;
drop trigger if exists trg_grade_checks_after_write on grade_checks;
create trigger trg_grade_checks_after_write after insert or update on grade_checks
  for each row execute function grade_checks_after_write();

-- When the mine answers or corporate closes, the alerts about it close.
create or replace function grade_checks_close_alerts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status and new.status in ('Accepted by mine', 'Disputed by mine', 'Closed') then
    update alerts set status = 'Resolved'
     where source_table = 'grade_checks' and source_id = new.check_id::text and status in ('Open', 'Acknowledged');
  end if;
  if new.status = 'Closed' and old.status <> 'Closed' then
    update alerts set status = 'Resolved'
     where source_table = 'grade_checks' and source_id like new.check_id::text || ':%' and status in ('Open', 'Acknowledged');
  end if;
  return null;
end $$;
drop trigger if exists trg_grade_checks_close_alerts on grade_checks;
create trigger trg_grade_checks_close_alerts after update on grade_checks
  for each row execute function grade_checks_close_alerts();

alter table grade_checks add column if not exists mine_answer text
  check (mine_answer in ('Accepted', 'Disputed'));

alter table grade_checks enable row level security;
drop policy if exists "Read grade checks scoped" on grade_checks;
create policy "Read grade checks scoped" on grade_checks
  for select using (is_oversight() or (mine_id = auth_mine_id()
                    and auth_role() in ('mine_official', 'inspector', 'contractor_manager')));
drop policy if exists "Inspectors record grade checks" on grade_checks;
create policy "Inspectors record grade checks" on grade_checks
  for insert with check (
    auth_role() in ('corporate_admin', 'admin')
    or (auth_role() = 'inspector' and mine_id = auth_mine_id()));
drop policy if exists "Answer grade checks" on grade_checks;
create policy "Answer grade checks" on grade_checks
  for update using (
    auth_role() in ('corporate_admin', 'admin')
    or (auth_role() = 'mine_official' and mine_id = auth_mine_id()));

-- Both tables are part of the audit trail.
drop trigger if exists trg_audit_coal_dispatches on coal_dispatches;
create trigger trg_audit_coal_dispatches after insert or update on coal_dispatches
  for each row execute function audit_row_change('dispatch_id');
drop trigger if exists trg_audit_grade_checks on grade_checks;
create trigger trg_audit_grade_checks after insert or update on grade_checks
  for each row execute function audit_row_change('check_id');

-- ------------------------------------------------------------
-- 4. Views
-- ------------------------------------------------------------
drop view if exists dispatch_view;
create view dispatch_view as
select d.*, m.mine_name, m.state,
       og.grade as official_grade, og.fy as official_fy, og.provisional as official_provisional,
       (og.grade is not null and grade_rank(d.declared_grade) < grade_rank(og.grade)) as declared_above_official,
       (select count(*) from grade_checks g where g.dispatch_id = d.dispatch_id) as checks,
       (select g.verdict from grade_checks g where g.dispatch_id = d.dispatch_id
         order by g.checked_at desc limit 1) as latest_verdict
  from coal_dispatches d join mines m using (mine_id)
  left join lateral official_grade_of(d.mine_id) og on true;
alter view dispatch_view set (security_invoker = true);
grant select on dispatch_view to authenticated;

drop view if exists grade_check_view;
create view grade_check_view as
select g.*, d.dispatch_date, d.mode, d.vehicle_ref, d.consignee, d.quantity_t, d.dispatch_point,
       m.mine_name, m.state, og.grade as official_grade, og.fy as official_fy,
       ip.full_name as inspector_name, rp.full_name as responded_by_name, cp.full_name as closed_by_name
  from grade_checks g
  join coal_dispatches d using (dispatch_id)
  join mines m on m.mine_id = g.mine_id
  left join user_profiles ip on ip.profile_id = g.inspector_id
  left join user_profiles rp on rp.profile_id = g.responded_by
  left join user_profiles cp on cp.profile_id = g.closed_by
  left join lateral official_grade_of(g.mine_id) og on true;
alter view grade_check_view set (security_invoker = true);
grant select on grade_check_view to authenticated;

-- Per mine: how much of what was checked left below its declared grade.
drop view if exists grade_slippage_by_mine;
create view grade_slippage_by_mine as
select g.mine_id, m.mine_name, m.state,
       count(*)                                                   as checks,
       count(*) filter (where g.verdict = 'Grade slippage')       as slippage_checks,
       coalesce(sum(d.quantity_t) filter (where g.verdict = 'Grade slippage'), 0) as tonnes_slipped,
       round(avg(g.grade_gap) filter (where g.verdict = 'Grade slippage'), 1)     as avg_grades_below,
       count(*) filter (where g.verdict = 'Lab test needed')      as awaiting_lab_test,
       max(g.checked_at)                                          as last_checked
  from grade_checks g
  join coal_dispatches d using (dispatch_id)
  join mines m on m.mine_id = g.mine_id
 group by g.mine_id, m.mine_name, m.state;
alter view grade_slippage_by_mine set (security_invoker = true);
grant select on grade_slippage_by_mine to authenticated;

-- Declared grades with the mines they cover, for the reference table.
drop view if exists declared_grade_view;
create view declared_grade_view as
select g.*, (select string_agg(m.mine_name, ', ' order by m.mine_name) from mines m where m.mine_id = any (g.mine_ids)) as mine_names
  from declared_grades g;
alter view declared_grade_view set (security_invoker = true);
grant select on declared_grade_view to authenticated;
