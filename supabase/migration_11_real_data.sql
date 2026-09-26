-- ============================================================
-- Migration 11 — real data in place of synthetic where it exists
--
--   1. Real production basis      Each mine's actual 2019-20 output (from
--                                 Indian_Coal_Mines_Dataset_January_2021)
--                                 is stored on the mine. Daily production
--                                 targets are set from it instead of a
--                                 random number.
--   2. Ambient air quality        CPCB's 2023 annual averages were loaded
--      near each mine             but linked to nothing. Each CPCB city in
--                                 the coal belt now has coordinates, and
--                                 every mine is linked to its nearest
--                                 station (within 60 km) and compared with
--                                 the national annual limits (NAAQS 2009).
--   3. Relinking the demo         apply_real_data_links() re-applies the
--      records                    geo-fence check to the corrected demo
--                                 inspections, keeps alerts pointing at
--                                 the right mine, and rescales demo
--                                 production to each mine's real output.
--
-- Run after migration_10_governance_completion.sql, then run
-- apply_real_data.py once. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Real production basis
-- ------------------------------------------------------------
alter table mines add column if not exists production_2019_20_mt numeric(10,6);
comment on column mines.production_2019_20_mt is
  'Actual coal/lignite output in 2019-20, million tonnes (Indian_Coal_Mines_Dataset_January_2021).';

-- Below this a mine was effectively idle in 2019-20, and its output is
-- not a sensible basis for a daily target (10,000 t a year is ~27 t/day).
create or replace function production_basis_min_mt()
returns numeric language sql immutable as $$ select 0.01::numeric $$;

-- ------------------------------------------------------------
-- 2. Ambient air quality near each mine
-- ------------------------------------------------------------
alter table air_quality_records add column if not exists latitude  numeric(9,6);
alter table air_quality_records add column if not exists longitude numeric(9,6);

-- Annual limits, National Ambient Air Quality Standards (CPCB, 2009),
-- industrial/residential/rural areas, µg/m³.
create or replace view naaqs_annual_limits as
select * from (values
  ('PM10',  60::numeric, 'µg/m³'),
  ('PM2.5', 40::numeric, 'µg/m³'),
  ('SO2',   50::numeric, 'µg/m³'),
  ('NO2',   40::numeric, 'µg/m³')
) as t(parameter, annual_limit, unit);
grant select on naaqs_annual_limits to authenticated;

-- Each mine's nearest CPCB city with 2023 data, if one is within 60 km.
-- The station measures the town's air, not the mine's boundary: it shows
-- the exposure of the community around the mine, which is what the
-- annual limits protect.
create or replace view mine_air_quality_view as
select m.mine_id, m.mine_name,
       aq.city_town, aq.state, aq.report_year,
       round(aq.dist_m / 1000.0, 1) as distance_km,
       aq.pm10_annual_avg, aq.pm25_annual_avg, aq.so2_annual_avg, aq.no2_annual_avg,
       aq.pm10_annual_avg > 60 as pm10_exceeds,
       aq.pm25_annual_avg > 40 as pm25_exceeds,
       aq.so2_annual_avg  > 50 as so2_exceeds,
       aq.no2_annual_avg  > 40 as no2_exceeds,
       aq.source
  from mines m
  cross join lateral (
    select a.*, haversine_m(m.latitude, m.longitude, a.latitude, a.longitude) as dist_m
      from air_quality_records a
     where a.latitude is not null and m.latitude is not null
     order by haversine_m(m.latitude, m.longitude, a.latitude, a.longitude), a.report_year desc
     limit 1
  ) aq
 where aq.dist_m <= 60000;
alter view mine_air_quality_view set (security_invoker = true);
grant select on mine_air_quality_view to authenticated;

-- The coal-belt stations, worst first, with how many mines each covers.
create or replace view coalfield_air_quality_view as
select a.record_id, a.city_town, a.state, a.report_year, a.latitude, a.longitude,
       a.pm10_annual_avg, a.pm25_annual_avg, a.so2_annual_avg, a.no2_annual_avg,
       a.pm10_annual_avg > 60 as pm10_exceeds,
       a.pm25_annual_avg > 40 as pm25_exceeds,
       a.so2_annual_avg  > 50 as so2_exceeds,
       a.no2_annual_avg  > 40 as no2_exceeds,
       coalesce(n.mines_nearby, 0) as mines_nearby,
       a.source
  from air_quality_records a
  left join (select city_town, state, count(*) as mines_nearby
               from mine_air_quality_view group by 1, 2) n
         on n.city_town = a.city_town and n.state = a.state
 where a.latitude is not null;
alter view coalfield_air_quality_view set (security_invoker = true);
grant select on coalfield_air_quality_view to authenticated;

-- ------------------------------------------------------------
-- 3. Relinking the demo records (service role only)
-- ------------------------------------------------------------
create or replace function apply_real_data_links()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_geo int; n_alerts int; n_prod int; n_prod_mines int;
begin
  -- a) Geo-fence verdicts for demo inspections whose mine or position was
  --    corrected. Real inspections are never touched: what an inspector
  --    recorded is evidence.
  with c as (
    select g.inspection_id, x.distance_m, x.within
      from geo_inspections g
      cross join lateral geofence_check(g.mine_id, g.latitude, g.longitude) x
     where g.is_synthetic
  )
  update geo_inspections g
     set distance_from_mine_m = c.distance_m,
         within_geofence      = c.within
    from c
   where g.inspection_id = c.inspection_id
     and (g.distance_from_mine_m, g.within_geofence) is distinct from (c.distance_m, c.within);
  get diagnostics n_geo = row_count;

  -- b) Alerts follow the record they are about.
  update alerts a set mine_id = s.mine_id
    from (select 'geo_inspections'::text t, inspection_id::text id, mine_id from geo_inspections
          union all select 'grievances', grievance_id::text, mine_id from grievances
          union all select 'contractors', contractor_id::text, mine_id from contractors) s
   where a.source_table = s.t and a.source_id = s.id
     and s.mine_id is not null and a.mine_id is distinct from s.mine_id;
  get diagnostics n_alerts = row_count;

  -- c) Demo production scaled to each mine's real 2019-20 output. The
  --    daily target becomes annual output / 365; produced, dispatched and
  --    overburden keep their day-to-day pattern around it. A mine already
  --    on its real basis has factor 1 and is left alone.
  with cur as (
    select mine_id, avg(t) as daily_target
      from (select mine_id, production_date, sum(target_t) t
              from mine_production_daily where is_synthetic group by 1, 2) d
     group by 1
  ), f as (
    select c.mine_id, (m.production_2019_20_mt * 1e6 / 365) / c.daily_target as factor
      from cur c join mines m using (mine_id)
     where m.production_2019_20_mt >= production_basis_min_mt()
       and c.daily_target > 0
       and abs((m.production_2019_20_mt * 1e6 / 365) / c.daily_target - 1) > 0.001
  )
  update mine_production_daily p
     set coal_produced_t       = round(p.coal_produced_t * f.factor, 1),
         coal_dispatched_t     = round(p.coal_dispatched_t * f.factor, 1),
         overburden_removed_m3 = round(p.overburden_removed_m3 * f.factor, 1),
         target_t              = round(p.target_t * f.factor, 1)
    from f
   where p.mine_id = f.mine_id and p.is_synthetic;
  get diagnostics n_prod = row_count;

  select count(distinct mine_id) into n_prod_mines
    from mine_production_daily p join mines m using (mine_id)
   where p.is_synthetic and m.production_2019_20_mt >= production_basis_min_mt();

  return jsonb_build_object(
    'inspections_geofence_updated', n_geo,
    'alerts_relinked', n_alerts,
    'production_rows_rescaled', n_prod,
    'mines_on_real_production_basis', n_prod_mines);
end $$;

revoke execute on function apply_real_data_links() from public, anon, authenticated;
grant execute on function apply_real_data_links() to service_role;
