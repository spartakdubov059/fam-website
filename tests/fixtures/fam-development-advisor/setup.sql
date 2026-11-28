create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema private;
create table private.fam_agent_daily_reports (
  report_date date primary key,
  generated_at timestamptz not null,
  summary text not null,
  metrics jsonb not null
);
alter table private.fam_agent_daily_reports enable row level security;
alter table private.fam_agent_daily_reports force row level security;
create policy deny_client_access_to_fam_agent_daily_reports
  on private.fam_agent_daily_reports
  for all to anon, authenticated
  using (false) with check (false);
revoke all on schema private from public, anon, authenticated;
revoke all on table private.fam_agent_daily_reports from public, anon, authenticated;
grant usage on schema private to service_role;
grant select on private.fam_agent_daily_reports to service_role;

insert into private.fam_agent_daily_reports(report_date,generated_at,summary,metrics)
select
  (pg_catalog.now() at time zone 'UTC')::date - offset_days,
  pg_catalog.now(),
  'synthetic aggregate only',
  pg_catalog.jsonb_build_object(
    'listings',
    pg_catalog.jsonb_build_object('active',40-offset_days,'new_24h',offset_days)
  )
from pg_catalog.generate_series(0,6) as generated(offset_days);
