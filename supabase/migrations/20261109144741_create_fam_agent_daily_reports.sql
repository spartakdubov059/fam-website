create table private.fam_agent_daily_reports (
  report_date date primary key,
  generated_at timestamptz not null default pg_catalog.now(),
  summary text not null,
  metrics jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(metrics) = 'object')
);

comment on table private.fam_agent_daily_reports is
  'Daily FAM operations digest. Aggregate counts only; never store message text, user identifiers, email addresses, or raw reports.';

alter table private.fam_agent_daily_reports enable row level security;
alter table private.fam_agent_daily_reports force row level security;

create policy deny_client_access_to_fam_agent_daily_reports
  on private.fam_agent_daily_reports
  for all to anon, authenticated
  using (false) with check (false);

revoke all on table private.fam_agent_daily_reports from public, anon, authenticated;
grant select, insert, update on table private.fam_agent_daily_reports to service_role;

create or replace function private.refresh_fam_agent_daily_report()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_report_date date := (pg_catalog.now() at time zone 'UTC')::date;
  v_generated_at timestamptz := pg_catalog.now();
  v_metrics jsonb;
  v_summary text;
begin
  select pg_catalog.jsonb_build_object(
    'listings', pg_catalog.jsonb_build_object(
      'active', (select count(*)::integer from public.listings where status = 'active'),
      'new_24h', (select count(*)::integer from public.listings where created_at >= pg_catalog.now() - interval '24 hours')
    ),
    'safety', pg_catalog.jsonb_build_object(
      'unreviewed', (select count(*)::integer from public.fam_safety_incidents where reviewed_at is null),
      'high_unreviewed', (select count(*)::integer from public.fam_safety_incidents where reviewed_at is null and severity = 'high')
    ),
    'account_requests', pg_catalog.jsonb_build_object(
      'deletion_pending', (select count(*)::integer from public.account_deletion_requests where status in ('pending', 'processing')),
      'active_suspensions', (select count(*)::integer from public.account_suspensions where status = 'active')
    ),
    'ideas', pg_catalog.jsonb_build_object(
      'pending', (select count(*)::integer from private.fam_agent_ideas where status = 'pending'),
      'approved', (select count(*)::integer from private.fam_agent_ideas where status = 'approved'),
      'rejected', (select count(*)::integer from private.fam_agent_ideas where status = 'rejected')
    ),
    'tasks', pg_catalog.jsonb_build_object(
      'queued', (select count(*)::integer from private.fam_agent_tasks where status = 'queued'),
      'completed_24h', (select count(*)::integer from private.fam_agent_tasks where status = 'completed' and finished_at >= pg_catalog.now() - interval '24 hours'),
      'blocked_24h', (select count(*)::integer from private.fam_agent_tasks where status = 'blocked' and updated_at >= pg_catalog.now() - interval '24 hours'),
      'failed_24h', (select count(*)::integer from private.fam_agent_tasks where status = 'failed' and updated_at >= pg_catalog.now() - interval '24 hours')
    )
  ) into v_metrics;

  v_summary := pg_catalog.format(
    'FAM — сводка за %s: активных объявлений %s, новых за сутки %s; непроверенных сигналов безопасности %s, из них высокого уровня %s; запросов на удаление %s; идей ждут решения %s; задач в очереди %s; задач выполнено за сутки %s.',
    pg_catalog.to_char(v_report_date, 'DD.MM.YYYY'),
    v_metrics #>> '{listings,active}',
    v_metrics #>> '{listings,new_24h}',
    v_metrics #>> '{safety,unreviewed}',
    v_metrics #>> '{safety,high_unreviewed}',
    v_metrics #>> '{account_requests,deletion_pending}',
    v_metrics #>> '{ideas,pending}',
    v_metrics #>> '{tasks,queued}',
    v_metrics #>> '{tasks,completed_24h}'
  );

  insert into private.fam_agent_daily_reports (report_date, generated_at, summary, metrics)
  values (v_report_date, v_generated_at, v_summary, v_metrics)
  on conflict (report_date) do update
    set generated_at = excluded.generated_at,
        summary = excluded.summary,
        metrics = excluded.metrics;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'report_date', v_report_date,
    'generated_at', v_generated_at,
    'summary', v_summary,
    'metrics', v_metrics
  );
end;
$function$;

revoke all on function private.refresh_fam_agent_daily_report() from public, anon, authenticated;
grant execute on function private.refresh_fam_agent_daily_report() to postgres;

select cron.schedule(
  'fam-agent-daily-report',
  '0 6 * * *',
  'select private.refresh_fam_agent_daily_report();'
);
