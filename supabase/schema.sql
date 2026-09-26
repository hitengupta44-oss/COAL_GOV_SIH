-- ============================================================
-- Smart Governance Platform for Coal Mining Operations
-- SIH 2026 PS: 26024
-- Supabase Postgres Schema
-- ============================================================
-- Run this in Supabase SQL Editor (Project > SQL Editor > New Query)
-- Designed to be loaded in order: reference tables first, then
-- transactional/fact tables that reference them.
-- ============================================================

-- ------------------------------------------------------------
-- 0. EXTENSIONS
-- ------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists postgis;   -- for geo point columns (mine locations, geo-tagged inspections)

-- ------------------------------------------------------------
-- 1. REFERENCE / MASTER TABLES
-- ------------------------------------------------------------

-- Subsidiaries / companies (CIL subsidiaries, SCCL, NLC, private/captive owners)
create table subsidiaries (
    subsidiary_id       serial primary key,
    subsidiary_code      text unique not null,       -- e.g. 'ECL', 'BCCL', 'SCCL'
    subsidiary_name      text not null,
    parent_company        text,                        -- e.g. 'Coal India Limited', null for SCCL/NLC/captive
    ownership_type        text check (ownership_type in ('Government','Private','Joint Venture')),
    created_at             timestamptz default now()
);

-- Mine master table (from Coal Directory + Harvard geolocation dataset)
create table mines (
    mine_id                uuid primary key default uuid_generate_v4(),
    mine_name              text not null,
    state                    text,
    district                text,
    subsidiary_id          int references subsidiaries(subsidiary_id),
    coal_type               text check (coal_type in ('Coal','Lignite')),
    mine_type               text check (mine_type in ('OC','UG','Mixed')),   -- opencast / underground
    ownership               text check (ownership in ('Government','Private')),
    latitude                 numeric(9,6),
    longitude                numeric(9,6),
    geo_accuracy            text,                        -- 'Exact' / 'Approximate' (from source dataset)
    source_reference        text,
    created_at              timestamptz default now(),
    updated_at              timestamptz default now()
);

create index idx_mines_subsidiary on mines(subsidiary_id);
create index idx_mines_geo on mines(latitude, longitude);

-- Users / staff profiles (linked 1:1 to Supabase Auth's auth.users table)
--
-- MIGRATION NOTE (Firebase -> Supabase Auth): this table used to key off a
-- `firebase_uid text` column. It now keys off `auth_uid`, a uuid that
-- REFERENCES auth.users(id) -- the table Supabase Auth manages natively.
-- This is the change that makes real RLS possible: inside a policy,
-- auth.uid() returns the logged-in user's auth.users.id, so we can write
-- policies like `auth_uid = auth.uid()` and have Postgres itself enforce
-- that people only read their own row. That was impossible with Firebase,
-- because Supabase had no way to verify a Firebase-issued JWT.
--
-- `on delete cascade`: deleting a user in the Supabase Auth dashboard now
-- cleanly removes their profile row too, instead of orphaning it.
create table user_profiles (
    profile_id          uuid primary key default uuid_generate_v4(),
    auth_uid             uuid unique not null references auth.users(id) on delete cascade,
    full_name            text,
    email                  text,
    role                   text check (role in ('worker','mine_official','corporate_admin','regulator','inspector','contractor_manager','admin')) not null,
    mine_id               uuid references mines(mine_id),      -- nullable: corporate/regulator roles aren't tied to one mine
    subsidiary_id        int references subsidiaries(subsidiary_id),
    created_at            timestamptz default now()
);

-- ------------------------------------------------------------
-- 2. PRODUCTION & ECONOMICS  (coal_dataset_2.pdf, RS_Session_265_AU_52_B.csv)
-- ------------------------------------------------------------

create table production_records (
    record_id            serial primary key,
    fiscal_year          text not null,             -- '2023-24'
    subsidiary_id        int references subsidiaries(subsidiary_id),
    company_group        text,                        -- 'CIL' / 'SCCL' / 'Others-Captive' for national-level rows
    production_mt        numeric(10,3),
    dispatch_mt           numeric(10,3),
    revenue_crore         numeric(14,2),
    source                  text default 'coal_dataset_2 / RS_Session_265_AU_52_B',
    created_at             timestamptz default now()
);

-- ------------------------------------------------------------
-- 3. SAFETY: ACCIDENTS  (coal_dataset_2.xlsx, RS_Session_256_AU_3306_1.csv,
--    table_fatal_accidents_owner_wise_2017_2024.csv, table_fatal_accidents_totals)
-- ------------------------------------------------------------

create table accidents (
    accident_id           uuid primary key default uuid_generate_v4(),
    mine_id                 uuid references mines(mine_id),          -- null when only state/company level is known
    subsidiary_id          int references subsidiaries(subsidiary_id),
    state                    text,
    accident_date           date,
    year                     int not null,
    severity                 text check (severity in ('Fatal','Serious')) not null,
    location_type           text check (location_type in ('Belowground','Opencast','Aboveground')),
    accident_count          int default 1,
    persons_affected        int default 1,             -- killed (fatal) or seriously injured (serious)
    responsibility           text,                        -- from report 2.2.4, if available
    source                   text,
    created_at              timestamptz default now()
);

create index idx_accidents_mine on accidents(mine_id);
create index idx_accidents_year on accidents(year);

-- ------------------------------------------------------------
-- 4. STATUTORY COMPLIANCE  (coal_dataset_3.pdf Gazette -> manually digitized checklist)
-- ------------------------------------------------------------

create table statutory_compliance_items (
    item_id                 serial primary key,
    regulation_source       text not null,             -- e.g. 'Coal Mines Regulations 2017, Reg 106'
    category                  text check (category in ('Safety','Environment','Production','Labour')) not null,
    requirement_summary     text not null,             -- paraphrased, not verbatim from gazette
    frequency                 text,                        -- 'Daily','Monthly','Annual','Event-based'
    applicable_mine_type    text,                        -- 'OC','UG','Both'
    created_at               timestamptz default now()
);

-- Per-mine compliance tracking against the checklist above
create table compliance_tracking (
    tracking_id            uuid primary key default uuid_generate_v4(),
    mine_id                  uuid references mines(mine_id) not null,
    item_id                  int references statutory_compliance_items(item_id) not null,
    due_date                  date,
    completed_date           date,
    status                    text check (status in ('Pending','Completed','Overdue','Not Applicable')) default 'Pending',
    submitted_by             uuid references user_profiles(profile_id),
    remarks                   text,
    created_at               timestamptz default now()
);

create index idx_compliance_mine on compliance_tracking(mine_id);
create index idx_compliance_status on compliance_tracking(status);

-- ------------------------------------------------------------
-- 5. INSPECTIONS & VIOLATIONS  (DGMS Annual Report tables 3, 4, 5, 8)
-- ------------------------------------------------------------

-- Aggregate DGMS-level stats (state/national, not mine-specific -- from official report)
create table dgms_inspection_stats (
    stat_id                  serial primary key,
    report_year              int not null,
    mine_category            text check (mine_category in ('Coal Mines','Metal Mines','Oil Mines')),
    inspections               int,
    enquiries                  int,
    source                     text default 'DGMS Annual Report',
    created_at                timestamptz default now()
);

create table dgms_violation_categories (
    category_id             serial primary key,
    report_year              int not null,
    mine_category             text default 'Coal Mines',
    order_type                 text check (order_type in ('Improvement Notice','Prohibitory Order')),
    defect_nature              text not null,
    no_of_cases                int default 0,
    source                     text default 'DGMS Annual Report'
);

create table permissions_exemptions (
    permission_id            serial primary key,
    report_year               int not null,
    mine_category              text default 'Coal Mines',
    particulars                 text not null,
    no_of_cases                 int default 0,
    source                      text default 'DGMS Annual Report'
);

-- Mine-level, geo-tagged field inspections (submitted via the Inspector web dashboard using browser geolocation -- MOCK DATA until real field data flows in)
create table geo_inspections (
    inspection_id            uuid primary key default uuid_generate_v4(),
    mine_id                    uuid references mines(mine_id),
    inspector_id                uuid references user_profiles(profile_id),
    "timestamp"                 timestamptz not null,
    latitude                     numeric(9,6),
    longitude                    numeric(9,6),
    observation_type            text,
    severity                      text check (severity in ('Low','Medium','High','Critical')),
    photo_url                     text,
    corrective_action_status    text check (corrective_action_status in ('Open','In Progress','Closed','Overdue')) default 'Open',
    notes                         text,
    is_synthetic                 boolean default false,   -- flag: true for demo/mock rows
    created_at                    timestamptz default now()
);

create index idx_geo_inspections_mine on geo_inspections(mine_id);

-- ------------------------------------------------------------
-- 6. ENVIRONMENTAL MONITORING  (AIRQUALITY_DATA2023.pdf, WQuality_Data-2025.pdf)
-- ------------------------------------------------------------

create table air_quality_records (
    record_id             serial primary key,
    report_year            int not null,
    state                    text,
    city_town                text,
    so2_annual_avg          numeric(6,2),
    no2_annual_avg          numeric(6,2),
    pm10_annual_avg         numeric(6,2),
    pm25_annual_avg         numeric(6,2),
    mine_id                  uuid references mines(mine_id),   -- nullable, link manually where city maps to a mine district
    source                   text default 'CPCB AIRQUALITY_DATA2023',
    created_at               timestamptz default now()
);

create table water_quality_records (
    record_id              serial primary key,
    report_year             int not null,
    station_code             text,
    monitoring_location     text,
    state                     text,
    dissolved_oxygen_min   numeric(5,2),
    dissolved_oxygen_max   numeric(5,2),
    ph_min                    numeric(4,2),
    ph_max                    numeric(4,2),
    bod_min                   numeric(6,2),
    bod_max                   numeric(6,2),
    fecal_coliform_min      numeric(12,2),
    fecal_coliform_max      numeric(12,2),
    source                    text default 'CPCB WQuality_Data-2025',
    created_at                timestamptz default now()
);

-- ------------------------------------------------------------
-- 7. CONTRACTOR MANAGEMENT  (mock -- no public source)
-- ------------------------------------------------------------

create table contractors (
    contractor_id          uuid primary key default uuid_generate_v4(),
    contractor_name         text not null,
    mine_id                   uuid references mines(mine_id),
    subsidiary_id            int references subsidiaries(subsidiary_id),
    contract_type             text,
    contract_start            date,
    contract_end              date,
    contract_value_lakh_inr numeric(12,2),
    status                     text check (status in ('Active','Under Review','Expired','Terminated')) default 'Active',
    blacklisted               boolean default false,
    is_synthetic              boolean default true,
    created_at                 timestamptz default now()
);

-- ------------------------------------------------------------
-- 8. WORKFORCE ATTENDANCE  (mock -- no public source)
-- ------------------------------------------------------------

create table attendance_records (
    record_id              serial primary key,
    mine_id                  uuid references mines(mine_id),
    subsidiary_id            int references subsidiaries(subsidiary_id),
    attendance_date          date not null,
    shift                      text check (shift in ('A','B','C')),
    workers_scheduled       int,
    workers_present          int,
    contractors_present     int,
    absentee_pct              numeric(5,2),
    is_synthetic              boolean default true,
    created_at                 timestamptz default now()
);

-- ------------------------------------------------------------
-- 9. GRIEVANCE HANDLING  (mock -- no public source)
-- ------------------------------------------------------------

create table grievances (
    grievance_id           uuid primary key default uuid_generate_v4(),
    mine_id                   uuid references mines(mine_id),
    subsidiary_id            int references subsidiaries(subsidiary_id),
    filed_by                  uuid references user_profiles(profile_id),
    date_filed                 date not null,
    category                   text,
    description                text,
    status                     text check (status in ('Resolved','In Progress','Escalated','Closed - No Action')) default 'In Progress',
    days_to_resolve           int,
    escalated                  boolean default false,
    is_synthetic               boolean default true,
    created_at                  timestamptz default now()
);

-- ------------------------------------------------------------
-- 10. AI / ANALYTICS OUTPUT  (for the Groq-powered anomaly & risk engine)
-- ------------------------------------------------------------

create table ai_risk_flags (
    flag_id                  uuid primary key default uuid_generate_v4(),
    mine_id                    uuid references mines(mine_id) not null,
    flag_type                  text check (flag_type in ('Recurring Violation','Anomalous Accident Rate','Compliance Gap','Environmental Threshold Breach')) not null,
    risk_score                 numeric(4,2),          -- 0.00 - 1.00
    explanation                 text,                    -- LLM-generated summary
    model_used                  text default 'groq',
    generated_at                timestamptz default now(),
    reviewed                    boolean default false
);

-- ------------------------------------------------------------
-- 11. AUDIT TRAIL  (for the blockchain-style / immutable audit log feature)
-- ------------------------------------------------------------

create table audit_log (
    log_id                    bigserial primary key,
    actor_uid                  uuid,                     -- auth.users(id) of the actor
    action                      text not null,
    table_affected              text,
    record_id                   text,
    details                      jsonb,
    "timestamp"                  timestamptz default now()
);

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- MIGRATION NOTE (Firebase -> Supabase Auth): the previous version had
-- only placeholder policies ("Public read mines", plus insert policies
-- checking auth.role() = 'authenticated'), with a comment saying to
-- tighten them "once Firebase custom-claims -> Supabase JWT bridging is
-- wired up". That bridging never existed, which is why user_profiles
-- ended up with a wide-open `using (true)` read policy -- Supabase had no
-- way to know who the Firebase-authenticated caller was.
--
-- Now that auth is native, auth.uid() works inside policies and we can
-- enforce real per-role, per-mine access in the database itself. This is
-- defense in depth: even if a bug in the frontend or backend lets a bad
-- request through, Postgres still refuses to return rows the caller
-- shouldn't see.
-- ------------------------------------------------------------

-- Helper: the calling user's role, read from their own profile row.
-- SECURITY DEFINER means this function runs as its owner and can read
-- user_profiles without recursively re-triggering user_profiles' own RLS
-- policies (a classic cause of "infinite recursion detected in policy").
create or replace function auth_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select role from user_profiles where auth_uid = auth.uid()
$$;

-- Helper: the calling user's assigned mine (null for corporate/regulator/admin).
create or replace function auth_mine_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
    select mine_id from user_profiles where auth_uid = auth.uid()
$$;

alter table user_profiles       enable row level security;
alter table mines               enable row level security;
alter table compliance_tracking enable row level security;
alter table geo_inspections     enable row level security;

-- --- user_profiles ---
-- Everyone may read their OWN profile row (this is what useAuth.js does on
-- login to discover the user's role). Admins may read every row so the
-- admin dashboard can list and manage users.
create policy "Read own profile" on user_profiles
    for select using (auth_uid = auth.uid() or auth_role() = 'admin');

-- Only admins may create or modify profile rows. This is what makes the
-- role field trustworthy: a normal user cannot promote themselves to
-- admin, because they cannot write to this table at all.
create policy "Admins insert profiles" on user_profiles
    for insert with check (auth_role() = 'admin');
create policy "Admins update profiles" on user_profiles
    for update using (auth_role() = 'admin');
create policy "Admins delete profiles" on user_profiles
    for delete using (auth_role() = 'admin');

-- --- mines ---
-- Any logged-in user may read the mine directory. Only corporate/admin
-- may modify it.
create policy "Authenticated read mines" on mines
    for select using (auth.uid() is not null);
create policy "Corporate manage mines" on mines
    for all using (auth_role() in ('corporate_admin','admin'));

-- --- compliance_tracking ---
-- Corporate, regulator and admin see everything (cross-mine oversight).
-- Mine-scoped roles only ever see their own mine's rows.
create policy "Read compliance scoped by mine" on compliance_tracking
    for select using (
        auth_role() in ('corporate_admin','regulator','admin')
        or mine_id = auth_mine_id()
    );
create policy "Update compliance scoped by mine" on compliance_tracking
    for update using (
        auth_role() in ('corporate_admin','admin')
        or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
    );
create policy "Insert compliance scoped by mine" on compliance_tracking
    for insert with check (
        auth_role() in ('corporate_admin','admin')
        or (auth_role() = 'mine_official' and mine_id = auth_mine_id())
    );

-- --- geo_inspections ---
create policy "Read inspections scoped by mine" on geo_inspections
    for select using (
        auth_role() in ('corporate_admin','regulator','admin')
        or mine_id = auth_mine_id()
    );
-- An inspector can only file an inspection for their own mine, and only
-- under their own identity -- inspector_id must be their own profile_id,
-- so nobody can log an inspection in someone else's name.
create policy "Insert own inspections" on geo_inspections
    for insert with check (
        auth_role() in ('inspector','mine_official','contractor_manager','admin')
        and (mine_id = auth_mine_id() or auth_role() = 'admin')
        and inspector_id = (select profile_id from user_profiles where auth_uid = auth.uid())
    );

-- ============================================================
-- END OF SCHEMA
-- ============================================================
