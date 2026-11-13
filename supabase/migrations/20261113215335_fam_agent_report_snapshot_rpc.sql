-- Read-only, aggregate-only snapshot for the cloud Reporter.
-- Not applied automatically. The Edge Function exposes it only to a token-authenticated service_role caller.

comment on table private.fam_agent_daily_reports is
  'Private daily FAM history. Stores aggregate metrics and an allowlisted sanitized system report; never store user content, identifiers, email, raw task payloads, or arbitrary task summaries.';

alter table private.fam_agent_daily_reports
  add column if not exists unified_report jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(unified_report) = 'object');

create or replace function public.save_fam_agent_system_report(
  p_report_date date,
  p_report jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_report_date is null
     or p_report is null
     or pg_catalog.jsonb_typeof(p_report) <> 'object'
     or p_report ->> 'report_date' is distinct from pg_catalog.to_char(p_report_date, 'YYYY-MM-DD')
     or pg_catalog.jsonb_typeof(p_report -> 'markdown') <> 'string'
     or pg_catalog.jsonb_typeof(p_report -> 'sources') <> 'object'
     or pg_catalog.jsonb_typeof(p_report -> 'workflows_24h') <> 'array'
     or pg_catalog.jsonb_typeof(p_report -> 'open_pull_requests') <> 'array'
     or pg_catalog.jsonb_typeof(p_report -> 'production_deployment') <> 'object'
     or pg_catalog.jsonb_typeof(p_report -> 'public_site') <> 'object'
     or pg_catalog.jsonb_typeof(p_report -> 'technical_analysis') <> 'object'
     or pg_catalog.jsonb_typeof(p_report -> 'limitations') <> 'array'
     or not (p_report ?& array[
       'report_date','generated_at','sources','supabase','workflows_24h',
       'open_pull_requests','role_statuses','technical_analysis','production_deployment','public_site','limitations','markdown'
     ])
     or (p_report - array[
       'report_date','generated_at','sources','supabase','workflows_24h',
       'open_pull_requests','role_statuses','technical_analysis','production_deployment','public_site','limitations','markdown'
     ]) <> '{}'::jsonb
     or pg_catalog.pg_column_size(p_report) > 65536 then
    raise exception 'invalid FAM system report';
  end if;

  update private.fam_agent_daily_reports as r
  set unified_report = p_report
  where r.report_date = p_report_date;

  if not found then
    insert into private.fam_agent_daily_reports (report_date, summary, metrics, unified_report)
    values (
      p_report_date,
      'Единый ежедневный отчёт FAM сохранён; подробности доступны только в закрытой схеме.',
      '{}'::jsonb,
      p_report
    )
    on conflict (report_date) do update
      set unified_report = excluded.unified_report;
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'report_date', p_report_date);
end;
$function$;

revoke all on function public.save_fam_agent_system_report(date, jsonb) from public, anon, authenticated;
grant execute on function public.save_fam_agent_system_report(date, jsonb) to service_role;

create or replace function public.get_fam_agent_report_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_daily_report jsonb;
  v_agent_statuses jsonb;
  v_cron_jobs jsonb;
  v_latest_health jsonb;
  v_latest_coder jsonb;
  v_latest_site_error jsonb;
  v_failed_tasks_24h jsonb;
  v_site_error_events jsonb;
  v_worker_http_6h jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'report_date', r.report_date,
    'generated_at', r.generated_at,
    'metrics', r.metrics
  )
  into v_daily_report
  from private.fam_agent_daily_reports as r
  order by r.report_date desc
  limit 1;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'agent_key', agents.agent_key,
        'queued', coalesce(counts.queued, 0),
        'claimed', coalesce(counts.claimed, 0),
        'in_progress', coalesce(counts.in_progress, 0),
        'blocked', coalesce(counts.blocked, 0),
        'completed_24h', coalesce(counts.completed_24h, 0),
        'failed_24h', coalesce(counts.failed_24h, 0)
      )
      order by agents.agent_key
    ),
    '[]'::jsonb
  )
  into v_agent_statuses
  from (values
    ('orchestrator'), ('technical'), ('database'), ('moderation'),
    ('safety'), ('quality'), ('growth')
  ) as agents(agent_key)
  left join lateral (
    select
      count(*) filter (where t.status = 'queued')::integer as queued,
      count(*) filter (where t.status = 'claimed')::integer as claimed,
      count(*) filter (where t.status = 'in_progress')::integer as in_progress,
      count(*) filter (where t.status = 'blocked')::integer as blocked,
      count(*) filter (where t.status = 'completed' and t.updated_at >= pg_catalog.now() - interval '24 hours')::integer as completed_24h,
      count(*) filter (where t.status = 'failed' and t.updated_at >= pg_catalog.now() - interval '24 hours')::integer as failed_24h
    from private.fam_agent_tasks as t
    where t.agent_key = agents.agent_key
  ) as counts on true;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'jobname', jobs.jobname,
        'schedule', jobs.schedule,
        'active', jobs.active,
        'last_run_status', latest.status,
        'last_run_at', latest.start_time
      )
      order by jobs.jobname
    ),
    '[]'::jsonb
  )
  into v_cron_jobs
  from cron.job as jobs
  left join lateral (
    select details.status, details.start_time
    from cron.job_run_details as details
    where details.jobid = jobs.jobid
    order by details.start_time desc
    limit 1
  ) as latest on true
  where jobs.jobname like 'fam-agent-%';

  select coalesce(
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('task_type', failures.task_type, 'count', failures.count) order by failures.task_type),
    '[]'::jsonb
  )
  into v_failed_tasks_24h
  from (
    select t.task_type, count(*)::integer as count
    from private.fam_agent_tasks as t
    where t.status = 'failed'
      and t.updated_at >= pg_catalog.now() - interval '24 hours'
      and t.task_type in (
        'coder_patch_request','system_health_check','site_error_digest',
        'queue_health_check','daily_report_digest'
      )
    group by t.task_type
  ) as failures;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'event_code', grouped.event_code,
        'page_area', grouped.page_area,
        'occurrences', grouped.occurrences
      )
      order by grouped.occurrences desc, grouped.event_code, grouped.page_area
    ),
    '[]'::jsonb
  )
  into v_site_error_events
  from (
    select c.event_code, c.page_area, pg_catalog.sum(c.event_count)::integer as occurrences
    from private.fam_site_error_counts as c
    where c.hour_bucket >= pg_catalog.now() - interval '24 hours'
      and c.event_code in (
        'js_runtime','unhandled_rejection','supabase_sdk_unavailable',
        'listings_load_failed','notifications_load_failed',
        'database_request_failed','auth_backend_failed'
      )
      and c.page_area in ('auth','listings','notifications','database','other')
    group by c.event_code, c.page_area
    order by pg_catalog.sum(c.event_count) desc, c.event_code, c.page_area
    limit 35
  ) as grouped;

  select pg_catalog.jsonb_build_object('status', t.status, 'updated_at', t.updated_at)
  into v_latest_health
  from private.fam_agent_tasks as t
  where t.agent_key = 'technical' and t.task_type = 'system_health_check'
  order by t.updated_at desc
  limit 1;

  select pg_catalog.jsonb_build_object('status', t.status, 'updated_at', t.updated_at)
  into v_latest_coder
  from private.fam_agent_tasks as t
  where t.agent_key = 'technical' and t.task_type = 'coder_patch_request'
  order by t.updated_at desc
  limit 1;

  select pg_catalog.jsonb_build_object('status', t.status, 'updated_at', t.updated_at)
  into v_latest_site_error
  from private.fam_agent_tasks as t
  where t.agent_key = 'technical' and t.task_type = 'site_error_digest'
  order by t.updated_at desc
  limit 1;

  -- pg_net keeps a bounded response history. Match the worker success envelope
  -- and fixed error codes; never expose response bodies, headers, or error text.
  select pg_catalog.jsonb_build_object(
    'window_hours', 6,
    'observed_from', min(r.created) filter (
      where (r.content like '{"ok":true,"claimed":%'
         and r.content like '%,"completed":%,"blocked":%}')
         or r.content in (
           '{"ok":false,"error":"method_not_allowed"}',
           '{"ok":false,"error":"origin_not_allowed"}',
           '{"ok":false,"error":"worker_not_configured"}',
           '{"ok":false,"error":"unauthorized"}',
           '{"ok":false,"error":"invalid_queue_response"}',
           '{"ok":false,"error":"worker_execution_failed"}'
         )
    ),
    'response_count', count(*) filter (
      where (r.content like '{"ok":true,"claimed":%'
         and r.content like '%,"completed":%,"blocked":%}')
         or r.content in (
           '{"ok":false,"error":"method_not_allowed"}',
           '{"ok":false,"error":"origin_not_allowed"}',
           '{"ok":false,"error":"worker_not_configured"}',
           '{"ok":false,"error":"unauthorized"}',
           '{"ok":false,"error":"invalid_queue_response"}',
           '{"ok":false,"error":"worker_execution_failed"}'
         )
    ),
    'success_count', count(*) filter (
      where r.status_code = 200
        and r.content like '{"ok":true,"claimed":%'
        and r.content like '%,"completed":%'
        and r.content like '%,"blocked":%}'
    ),
    'http_error_count', count(*) filter (
      where r.status_code >= 400 and r.content in (
        '{"ok":false,"error":"method_not_allowed"}',
        '{"ok":false,"error":"origin_not_allowed"}',
        '{"ok":false,"error":"worker_not_configured"}',
        '{"ok":false,"error":"unauthorized"}',
        '{"ok":false,"error":"invalid_queue_response"}',
        '{"ok":false,"error":"worker_execution_failed"}'
      )
    ),
    'reported_error_count', count(*) filter (
      where r.content in (
        '{"ok":false,"error":"method_not_allowed"}',
        '{"ok":false,"error":"origin_not_allowed"}',
        '{"ok":false,"error":"worker_not_configured"}',
        '{"ok":false,"error":"unauthorized"}',
        '{"ok":false,"error":"invalid_queue_response"}',
        '{"ok":false,"error":"worker_execution_failed"}'
      )
    )
  )
  into v_worker_http_6h
  from net._http_response as r
  where r.created >= pg_catalog.now() - interval '6 hours';

  return pg_catalog.jsonb_build_object(
    'generated_at', pg_catalog.now(),
    'report_date', (pg_catalog.now() at time zone 'UTC')::date,
    'daily_report', v_daily_report,
    'agent_statuses', v_agent_statuses,
    'cron_jobs', v_cron_jobs,
    'latest_system_health', v_latest_health,
    'latest_coder_task', v_latest_coder,
    'latest_site_error_check', v_latest_site_error,
    'worker_http_6h', v_worker_http_6h,
    'failed_tasks_24h', v_failed_tasks_24h,
    'site_error_events_24h', v_site_error_events
  );
end;
$function$;

revoke all on function public.get_fam_agent_report_snapshot() from public, anon, authenticated;
grant execute on function public.get_fam_agent_report_snapshot() to service_role;
