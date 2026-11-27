-- Privacy-preserving, FAM_CURRENT-only moderation summary for the daily staff report.
-- This exposes no school IDs, user IDs, excerpts, URLs, or counts from fewer than five schools.
create or replace function public.get_fam_moderation_aggregate_summary()
returns table(
  generated_at timestamptz,
  total_bucket text,
  categories jsonb
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with recent as (
    select i.school_id, i.category, i.severity
    from public.fam_safety_incidents as i
    where i.created_at >= pg_catalog.now() - interval '7 days'
  ), totals as (
    select count(distinct school_id)::bigint as total from recent
  ), category_counts as (
    select r.category, r.severity, count(distinct r.school_id)::bigint as total
    from recent as r
    group by r.category, r.severity
  )
  select
    pg_catalog.now(),
    case
      when totals.total = 0 then 'none'
      when totals.total < 5 then 'suppressed'
      when totals.total < 10 then '5_9'
      when totals.total < 25 then '10_24'
      else '25_plus'
    end,
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'category', cc.category,
          'severity', cc.severity,
          'count_bucket', case
            when cc.total < 10 then '5_9'
            when cc.total < 25 then '10_24'
            else '25_plus'
          end
        ) order by cc.category, cc.severity
      )
      from category_counts as cc
      where cc.total >= 5
    ), '[]'::jsonb)
  from totals;
$function$;

revoke all on function public.get_fam_moderation_aggregate_summary()
  from public, anon, authenticated;
grant execute on function public.get_fam_moderation_aggregate_summary()
  to service_role;

comment on function public.get_fam_moderation_aggregate_summary() is
  'Seven-day FAM_CURRENT moderation signal summary for the protected staff report. Counts schools with signals, suppresses cells under five schools, and excludes all identifiers and content.';
