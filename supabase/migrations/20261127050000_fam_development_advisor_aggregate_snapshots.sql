-- Read-only product-development signals for the FAM Development Advisor.
-- Exposes only existing daily listing aggregates; never reads profiles, registrations,
-- messages, moderation content, identifiers, or task payloads.
create or replace function public.get_fam_development_advisor_snapshots(p_days integer default 7)
returns table(
  report_date date,
  generated_at timestamptz,
  active_listings_band text,
  new_listings_24h_band text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    r.report_date,
    r.generated_at,
    case
      when coalesce(nullif(r.metrics #>> '{listings,active}', '')::integer, 0) = 0 then 'none'
      when coalesce(nullif(r.metrics #>> '{listings,active}', '')::integer, 0) < 5 then 'suppressed'
      when coalesce(nullif(r.metrics #>> '{listings,active}', '')::integer, 0) < 10 then '5_9'
      when coalesce(nullif(r.metrics #>> '{listings,active}', '')::integer, 0) < 25 then '10_24'
      else '25_plus'
    end,
    case
      when coalesce(nullif(r.metrics #>> '{listings,new_24h}', '')::integer, 0) = 0 then 'none'
      when coalesce(nullif(r.metrics #>> '{listings,new_24h}', '')::integer, 0) < 5 then 'suppressed'
      when coalesce(nullif(r.metrics #>> '{listings,new_24h}', '')::integer, 0) < 10 then '5_9'
      when coalesce(nullif(r.metrics #>> '{listings,new_24h}', '')::integer, 0) < 25 then '10_24'
      else '25_plus'
    end
  from private.fam_agent_daily_reports as r
  where p_days between 3 and 14
    and r.report_date >= (pg_catalog.now() at time zone 'UTC')::date - (p_days - 1)
    and r.report_date <= (pg_catalog.now() at time zone 'UTC')::date
  order by r.report_date desc
  limit 14;
$function$;

revoke all on function public.get_fam_development_advisor_snapshots(integer)
  from public, anon, authenticated;
grant execute on function public.get_fam_development_advisor_snapshots(integer)
  to service_role;

comment on function public.get_fam_development_advisor_snapshots(integer) is
  'Returns only privacy-banded listing aggregates for the read-only FAM Development Advisor; exact counts below five are suppressed.';
