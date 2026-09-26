-- ============================================================
-- Migration 12 — real monitoring data and lease boundaries
--
--   1. River water quality      CPCB's National Water Quality Monitoring
--      near each mine            Programme, 2024 (1,555 river stations).
--                                The ~70 stations on coal-belt rivers
--                                (Damodar, Barakar, Hasdeo, Kelo, Ib,
--                                Brahmani, Sone, Rihand, Wardha,
--                                Godavari, Kinnerasani...) are placed on
--                                the map, and each mine is linked to the
--                                three nearest within 25 km and checked
--                                against CPCB's primary water quality
--                                criteria.
--   2. A mine's own published   Readings copied from a mine's six-monthly
--      monitoring data           EC compliance report (Pakri Barwadih's
--                                continuous air-quality station, Oct 2023
--                                to Mar 2024) are stored as real readings
--                                with the document they came from. They
--                                are history, so they do not raise live
--                                alerts.
--   3. Lease boundaries          A mine can carry its lease boundary as a
--                                polygon (from a KML, or the lease extent
--                                stated in its EC report). Where it does,
--                                the geo-fence is the boundary itself,
--                                with 250 m allowed for GPS error, instead
--                                of a circle around a single point.
--
-- Run after migration_11_real_data.sql, then run load_real_monitoring.py.
-- Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. River water quality
-- ------------------------------------------------------------
alter table water_quality_records add column if not exists river                text;
alter table water_quality_records add column if not exists conductivity_min     numeric(10,2);
alter table water_quality_records add column if not exists conductivity_max     numeric(10,2);
alter table water_quality_records add column if not exists nitrate_min          numeric(8,2);
alter table water_quality_records add column if not exists nitrate_max          numeric(8,2);
alter table water_quality_records add column if not exists total_coliform_min   numeric(12,2);
alter table water_quality_records add column if not exists total_coliform_max   numeric(12,2);
alter table water_quality_records add column if not exists latitude             numeric(9,6);
alter table water_quality_records add column if not exists longitude            numeric(9,6);
alter table water_quality_records add column if not exists located_at           text;

-- CPCB primary water quality criteria for outdoor bathing (the criteria
-- printed at the head of every NWMP table): DO above 5 mg/L, pH 6.5-8.5,
-- BOD below 3 mg/L, faecal coliform below 2,500 MPN/100 mL.
create or replace view river_quality_assessed as
select w.*,
       (w.dissolved_oxygen_min < 5)                         as do_fails,
       (w.ph_min < 6.5 or w.ph_max > 8.5)                   as ph_fails,
       (w.bod_max >= 3)                                     as bod_fails,
       (w.fecal_coliform_max > 2500)                        as fc_fails,
         coalesce((w.dissolved_oxygen_min < 5)::int, 0)
       + coalesce((w.ph_min < 6.5 or w.ph_max > 8.5)::int, 0)
       + coalesce((w.bod_max >= 3)::int, 0)
       + coalesce((w.fecal_coliform_max > 2500)::int, 0)    as criteria_failed
  from water_quality_records w;
alter view river_quality_assessed set (security_invoker = true);
grant select on river_quality_assessed to authenticated;

-- The three nearest placed stations within 25 km of each mine, latest year.
create or replace view mine_water_quality_view as
select m.mine_id, s.*
  from mines m
  cross join lateral (
    select r.record_id, r.report_year, r.station_code, r.monitoring_location, r.river, r.state,
           r.located_at, round(haversine_m(m.latitude, m.longitude, r.latitude, r.longitude) / 1000.0, 1) as distance_km,
           r.dissolved_oxygen_min, r.ph_min, r.ph_max, r.bod_max, r.fecal_coliform_max,
           r.conductivity_max, r.nitrate_max,
           r.do_fails, r.ph_fails, r.bod_fails, r.fc_fails, r.criteria_failed,
           r.source
      from river_quality_assessed r
     where r.latitude is not null and m.latitude is not null
       and haversine_m(m.latitude, m.longitude, r.latitude, r.longitude) <= 25000
       and r.report_year = (select max(report_year) from water_quality_records x
                             where x.station_code = r.station_code and x.latitude is not null)
     order by haversine_m(m.latitude, m.longitude, r.latitude, r.longitude)
     limit 3
  ) s;
alter view mine_water_quality_view set (security_invoker = true);
grant select on mine_water_quality_view to authenticated;

-- Coal-belt stations, worst first, with how many mines each is near.
create or replace view coalfield_river_quality_view as
select r.record_id, r.report_year, r.station_code, r.monitoring_location, r.river, r.state, r.located_at,
       r.dissolved_oxygen_min, r.ph_min, r.ph_max, r.bod_max, r.fecal_coliform_max, r.conductivity_max,
       r.do_fails, r.ph_fails, r.bod_fails, r.fc_fails, r.criteria_failed,
       coalesce(n.mines_nearby, 0) as mines_nearby, r.source
  from river_quality_assessed r
  left join (select record_id, count(*) as mines_nearby from mine_water_quality_view group by 1) n
         using (record_id)
 where r.latitude is not null;
alter view coalfield_river_quality_view set (security_invoker = true);
grant select on coalfield_river_quality_view to authenticated;

-- ------------------------------------------------------------
-- 2. A mine's own published monitoring data
-- ------------------------------------------------------------
alter table env_readings add column if not exists source_document text;
comment on column env_readings.source_document is
  'Set when the reading was copied from a published document (e.g. an EC compliance report) rather than entered at the mine.';

-- Continuous analysers report NOx. NAAQS 2009 has no NOx standard; mines'
-- own CAAQMS reports compare it with the NO2 24-hour limit, and so do we.
insert into env_limits (parameter, medium, unit, min_value, max_value, basis) values
  ('NOx', 'Air', 'µg/m³', null, 80, 'Compared with the NO₂ 24-hour limit (NAAQS 2009); NAAQS sets no NOx standard')
on conflict (parameter) do nothing;

-- Readings from a published report are history: they are stored with
-- their breach verdict, but they do not page the mine official today.
-- Users can never set source_document themselves.
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
    new.source_document := null;
    if new.reading_date > current_date then
      raise exception 'A reading cannot be dated in the future.';
    end if;
  end if;
  select * into l from env_limits where parameter = new.parameter;
  new.limit_min := l.min_value;
  new.limit_max := l.max_value;
  new.exceeds_limit := (l.max_value is not null and new.value > l.max_value)
                    or (l.min_value is not null and new.value < l.min_value);
  return new;
end $$;

create or replace function env_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.exceeds_limit and new.source_document is null then
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

-- ------------------------------------------------------------
-- 3. Lease boundaries
-- ------------------------------------------------------------
create table if not exists mine_boundaries (
    mine_id       uuid primary key references mines(mine_id) on delete cascade,
    -- Closed ring of [latitude, longitude] pairs.
    boundary      jsonb not null check (jsonb_typeof(boundary) = 'array' and jsonb_array_length(boundary) >= 4),
    boundary_type text not null check (boundary_type in ('Surveyed lease polygon', 'Lease extent from EC report')),
    source        text not null,
    area_ha       numeric(10,2),
    loaded_at     timestamptz default now()
);
alter table mine_boundaries enable row level security;
drop policy if exists "Signed-in read" on mine_boundaries;
create policy "Signed-in read" on mine_boundaries for select using (auth.uid() is not null);
drop policy if exists "Corporate manage" on mine_boundaries;
create policy "Corporate manage" on mine_boundaries for all
  using (auth_role() in ('corporate_admin','admin'))
  with check (auth_role() in ('corporate_admin','admin'));

-- Is the point inside the ring? (Ray casting; the ring is small enough
-- that treating latitude/longitude as plane coordinates is exact enough.)
create or replace function point_in_ring(p_lat numeric, p_lon numeric, ring jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  n int := jsonb_array_length(ring);
  inside boolean := false;
  i int; j int;
  yi float8; xi float8; yj float8; xj float8;
begin
  if p_lat is null or p_lon is null then return null; end if;
  j := n - 1;
  for i in 0 .. n - 1 loop
    yi := (ring->i->>0)::float8; xi := (ring->i->>1)::float8;
    yj := (ring->j->>0)::float8; xj := (ring->j->>1)::float8;
    if ((yi > p_lat) <> (yj > p_lat))
       and (p_lon < (xj - xi) * (p_lat - yi) / nullif(yj - yi, 0) + xi) then
      inside := not inside;
    end if;
    j := i;
  end loop;
  return inside;
end $$;

-- Shortest distance in metres from the point to the ring's edge, using a
-- local flat projection (accurate to well under 1% at lease scale).
create or replace function distance_to_ring_m(p_lat numeric, p_lon numeric, ring jsonb)
returns numeric
language plpgsql
immutable
as $$
declare
  n int := jsonb_array_length(ring);
  k float8 := cos(radians(p_lat::float8));
  best float8 := null;
  i int;
  ax float8; ay float8; bx float8; by_ float8; t float8; dx float8; dy float8; d float8;
begin
  if p_lat is null or p_lon is null then return null; end if;
  for i in 0 .. n - 2 loop
    ax := ((ring->i->>1)::float8 - p_lon::float8) * k * 111320; ay := ((ring->i->>0)::float8 - p_lat::float8) * 110540;
    bx := ((ring->(i+1)->>1)::float8 - p_lon::float8) * k * 111320; by_ := ((ring->(i+1)->>0)::float8 - p_lat::float8) * 110540;
    dx := bx - ax; dy := by_ - ay;
    t := case when dx = 0 and dy = 0 then 0
              else greatest(0, least(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) end;
    d := sqrt(power(ax + t * dx, 2) + power(ay + t * dy, 2));
    if best is null or d < best then best := d; end if;
  end loop;
  return round(best::numeric, 0);
end $$;

-- The geo-fence check, now boundary-aware. With a boundary: inside it, or
-- within 250 m of it (phone GPS error), counts as at the mine, and the
-- distance reported is how far outside the boundary the point is (0 when
-- inside). Without one: the radius around the mine's point, as before.
create or replace function geofence_check(p_mine uuid, p_lat numeric, p_lon numeric,
                                          out distance_m numeric, out within boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b jsonb;
  m record;
begin
  select boundary into b from mine_boundaries where mine_id = p_mine;
  if b is not null and p_lat is not null and p_lon is not null then
    if point_in_ring(p_lat, p_lon, b) then
      distance_m := 0; within := true;
    else
      distance_m := distance_to_ring_m(p_lat, p_lon, b);
      within := distance_m <= 250;
    end if;
    return;
  end if;
  select latitude, longitude, geo_accuracy into m from mines where mine_id = p_mine;
  distance_m := haversine_m(p_lat, p_lon, m.latitude, m.longitude);
  within := case when distance_m is null then null
                 else distance_m <= geofence_radius_m(m.geo_accuracy) end;
end $$;
