create or replace function public.get_fam_agent_queue_health()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with stats as (
    select
      pg_catalog.count(*) filter (where t.status = 'queued') as queued,
      pg_catalog.count(*) filter (where t.status = 'claimed') as claimed,
      pg_catalog.count(*) filter (where t.status = 'in_progress') as in_progress,
      pg_catalog.count(*) filter (
        where t.status = 'failed'
          and t.updated_at >= pg_catalog.now() - interval '24 hours'
      ) as failed_last_24h,
      pg_catalog.count(*) filter (
        where t.status in ('claimed', 'in_progress')
          and t.lease_expires_at < pg_catalog.now()
      ) as expired_leases,
      pg_catalog.min(t.created_at) filter (where t.status = 'queued') as oldest_queued_at
    from private.fam_agent_tasks as t
  )
  select pg_catalog.jsonb_build_object(
    'queued', stats.queued,
    'claimed', stats.claimed,
    'in_progress', stats.in_progress,
    'failed_last_24h', stats.failed_last_24h,
    'expired_leases', stats.expired_leases,
    'oldest_queued_minutes',
      coalesce(
        pg_catalog.floor(extract(epoch from (pg_catalog.now() - stats.oldest_queued_at)) / 60)::integer,
        0
      )
  )
  from stats;
$function$;

revoke all on function public.get_fam_agent_queue_health() from public, anon, authenticated;
grant execute on function public.get_fam_agent_queue_health() to service_role;
