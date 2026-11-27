-- Read-only product-development signals for the FAM Development Advisor.
-- Exposes existing daily listing counts and a privacy-banded school-idea backlog;
-- never reads profiles, registrations, messages, moderation content, identifiers, or task payloads.
create or replace function public.get_fam_development_advisor_snapshots(p_days integer default 7)
returns table(
  report_date date,
  generated_at timestamptz,
  active_listings integer,
  new_listings_24h integer,
  pending_council_ideas_band text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    r.report_date,
    r.generated_at,
    coalesce(nullif(r.metrics #>> '{listings,active}', '')::integer, 0),
    coalesce(nullif(r.metrics #>> '{listings,new_24h}', '')::integer, 0),
    school_ideas.pending_band
  from private.fam_agent_daily_reports as r
  cross join lateral (
    select case
      when counts.reporting_schools < 5 or counts.positive_schools between 1 and 4 then 'suppressed'
      when counts.positive_schools = 0 then 'none'
      when counts.capped_total < 10 then '5_9'
      when counts.capped_total < 25 then '10_24'
      else '25_plus'
    end as pending_band
    from (
      select
        pg_catalog.count(*)::integer as reporting_schools,
        pg_catalog.count(*) filter (where pending_count > 0)::integer as positive_schools,
        coalesce(pg_catalog.sum(least(pending_count, 5)), 0)::integer as capped_total
      from (
        select greatest(
          coalesce(nullif(s.metrics #>> '{ideas,awaiting_council}', '')::integer, 0), 0
        ) as pending_count
        from private.fam_agent_school_daily_reports as s
        where s.report_date = r.report_date
      ) as per_school
    ) as counts
  ) as school_ideas
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
  'Returns systemwide listing aggregates and only banded idea-backlog counts when at least five schools report and at least five schools contribute; no content or identifiers.';
