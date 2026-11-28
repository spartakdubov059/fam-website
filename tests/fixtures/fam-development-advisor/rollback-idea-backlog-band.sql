-- Remove the idea-backlog signal while retaining the privacy-banded listing contract.
drop function public.get_fam_development_advisor_snapshots(integer);

create function public.get_fam_development_advisor_snapshots(p_days integer default 7)
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
      when nullif(r.metrics #>> '{listings,active}', '') is null
        or (r.metrics #>> '{listings,active}') !~ '^(0|[1-9][0-9]{0,17})$' then 'unknown'
      when (r.metrics #>> '{listings,active}')::numeric < 5 then 'suppressed'
      when (r.metrics #>> '{listings,active}')::numeric < 10 then '5_9'
      when (r.metrics #>> '{listings,active}')::numeric < 25 then '10_24'
      else '25_plus'
    end,
    case
      when nullif(r.metrics #>> '{listings,new_24h}', '') is null
        or (r.metrics #>> '{listings,new_24h}') !~ '^(0|[1-9][0-9]{0,17})$' then 'unknown'
      when (r.metrics #>> '{listings,new_24h}')::numeric < 5 then 'suppressed'
      when (r.metrics #>> '{listings,new_24h}')::numeric < 10 then '5_9'
      when (r.metrics #>> '{listings,new_24h}')::numeric < 25 then '10_24'
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
