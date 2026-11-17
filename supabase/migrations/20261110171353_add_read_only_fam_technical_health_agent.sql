create unique index if not exists fam_agent_tasks_technical_system_health_date_uidx
  on private.fam_agent_tasks ((payload ->> 'check_date'))
  where agent_key = 'technical'
    and task_type = 'system_health_check';

create or replace function public.claim_fam_agent_tasks(
  p_worker_id text,
  p_limit integer default 3,
  p_lease_seconds integer default 120
)
returns table(
  id uuid,
  agent_key text,
  task_type text,
  approval_required boolean
)
language plpgsql
set search_path = ''
as $function$
begin
  if p_worker_id is null
     or pg_catalog.char_length(pg_catalog.btrim(p_worker_id)) not between 1 and 80 then
    raise exception 'invalid worker id';
  end if;

  with exhausted as (
    update private.fam_agent_tasks as t
    set status = 'failed',
        result_summary = 'Задача остановлена после исчерпания попыток.',
        claimed_by = null,
        lease_expires_at = null,
        finished_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where t.status in ('claimed', 'in_progress')
      and t.lease_expires_at < pg_catalog.now()
      and t.attempt_count >= t.max_attempts
    returning t.id
  )
  insert into private.fam_agent_task_events (task_id, event_type, actor, summary)
  select e.id, 'failed', p_worker_id, 'Задача остановлена после исчерпания попыток.'
  from exhausted as e;

  return query
  with candidates as (
    select t.id
    from private.fam_agent_tasks as t
    where t.approval_required = false
      and (
        (t.agent_key = 'quality' and t.task_type = 'queue_health_check')
        or
        (t.agent_key = 'orchestrator' and t.task_type = 'daily_report_digest')
        or
        (t.agent_key = 'technical' and t.task_type = 'system_health_check')
      )
      and t.available_at <= pg_catalog.now()
      and t.attempt_count < t.max_attempts
      and (
        t.status = 'queued'
        or (t.status in ('claimed', 'in_progress') and t.lease_expires_at < pg_catalog.now())
      )
    order by
      case t.priority
        when 'urgent' then 0
        when 'high' then 1
        when 'normal' then 2
        else 3
      end,
      t.created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 5)
  ), claimed as (
    update private.fam_agent_tasks as t
    set status = 'claimed',
        claimed_by = p_worker_id,
        claimed_at = pg_catalog.now(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(
          secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 300)
        ),
        attempt_count = t.attempt_count + 1,
        updated_at = pg_catalog.now()
    from candidates as c
    where t.id = c.id
    returning t.id, t.agent_key, t.task_type, t.approval_required
  ), logged as (
    insert into private.fam_agent_task_events (task_id, event_type, actor, summary)
    select c.id, 'claimed', p_worker_id, 'Задание передано безопасному исполнителю.'
    from claimed as c
    returning task_id
  )
  select c.id, c.agent_key, c.task_type, c.approval_required
  from claimed as c
  join logged as l on l.task_id = c.id;
end;
$function$;

create or replace function public.get_fam_agent_task_system_health(
  p_task_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_authorized boolean;
  v_extensions jsonb;
  v_jobs jsonb;
  v_all_extensions_ok boolean;
  v_all_schedules_ok boolean;
  v_rpcs jsonb;
  v_all_rpcs_ok boolean;
  v_queue jsonb;
begin
  if p_task_id is null
     or p_worker_id is null
     or pg_catalog.char_length(pg_catalog.btrim(p_worker_id)) not between 1 and 80 then
    return null;
  end if;

  select exists (
    select 1
    from private.fam_agent_tasks as t
    where t.id = p_task_id
      and t.agent_key = 'technical'
      and t.task_type = 'system_health_check'
      and t.approval_required = false
      and t.claimed_by = p_worker_id
      and t.status = 'claimed'
      and t.lease_expires_at > pg_catalog.now()
  )
  into v_authorized;

  if not v_authorized then
    return null;
  end if;

  select
    pg_catalog.jsonb_build_object(
      'pg_cron', pg_catalog.jsonb_build_object(
        'installed', e_cron.extname is not null,
        'version', e_cron.extversion,
        'schema', n_cron.nspname
      ),
      'pg_net', pg_catalog.jsonb_build_object(
        'installed', e_net.extname is not null,
        'version', e_net.extversion,
        'schema', n_net.nspname
      )
    ),
    (e_cron.extname is not null and e_net.extname is not null)
  into v_extensions, v_all_extensions_ok
  from (select 1) as seed
  left join pg_catalog.pg_extension as e_cron on e_cron.extname = 'pg_cron'
  left join pg_catalog.pg_namespace as n_cron on n_cron.oid = e_cron.extnamespace
  left join pg_catalog.pg_extension as e_net on e_net.extname = 'pg_net'
  left join pg_catalog.pg_namespace as n_net on n_net.oid = e_net.extnamespace;

  with expected(jobname, expected_schedule) as (
    values
      ('fam-agent-worker-every-5-minutes', '*/5 * * * *'),
      ('fam-agent-school-daily-report', '0 6 * * *'),
      ('fam-agent-orchestrator-daily-digest', '5 6 * * *'),
      ('fam-agent-technical-system-health', '10 6 * * *')
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'job', e.jobname,
          'active', coalesce(j.active, false),
          'schedule_matches', coalesce(j.schedule = e.expected_schedule, false),
          'last_run_status', latest.status,
          'last_run_at', latest.start_time
        )
        order by e.jobname
      ),
      '[]'::jsonb
    ),
    coalesce(
      pg_catalog.bool_and(
        coalesce(j.active, false)
        and coalesce(j.schedule = e.expected_schedule, false)
      ),
      false
    )
  into v_jobs, v_all_schedules_ok
  from expected as e
  left join cron.job as j on j.jobname = e.jobname
  left join lateral (
    select d.status, d.start_time
    from cron.job_run_details as d
    where d.jobid = j.jobid
    order by d.start_time desc
    limit 1
  ) as latest on true;

  select
    pg_catalog.jsonb_build_object(
      'claim_rpc', pg_catalog.to_regprocedure('public.claim_fam_agent_tasks(text,integer,integer)') is not null
        and pg_catalog.has_function_privilege('service_role','public.claim_fam_agent_tasks(text,integer,integer)','EXECUTE'),
      'finish_rpc', pg_catalog.to_regprocedure('public.finish_fam_agent_task(uuid,text,text,text)') is not null
        and pg_catalog.has_function_privilege('service_role','public.finish_fam_agent_task(uuid,text,text,text)','EXECUTE'),
      'daily_digest_rpc', pg_catalog.to_regprocedure('public.get_fam_agent_task_daily_digest(uuid,text)') is not null
        and pg_catalog.has_function_privilege('service_role','public.get_fam_agent_task_daily_digest(uuid,text)','EXECUTE')
    ),
    (
      pg_catalog.to_regprocedure('public.claim_fam_agent_tasks(text,integer,integer)') is not null
      and pg_catalog.has_function_privilege('service_role','public.claim_fam_agent_tasks(text,integer,integer)','EXECUTE')
      and pg_catalog.to_regprocedure('public.finish_fam_agent_task(uuid,text,text,text)') is not null
      and pg_catalog.has_function_privilege('service_role','public.finish_fam_agent_task(uuid,text,text,text)','EXECUTE')
      and pg_catalog.to_regprocedure('public.get_fam_agent_task_daily_digest(uuid,text)') is not null
      and pg_catalog.has_function_privilege('service_role','public.get_fam_agent_task_daily_digest(uuid,text)','EXECUTE')
    )
  into v_rpcs, v_all_rpcs_ok;

  select pg_catalog.jsonb_build_object(
    'queued', count(*) filter (where t.status = 'queued'),
    'claimed', count(*) filter (where t.status = 'claimed'),
    'in_progress', count(*) filter (where t.status = 'in_progress'),
    'failed_last_24h', count(*) filter (
      where t.status = 'failed'
        and t.updated_at >= pg_catalog.now() - interval '24 hours'
    ),
    'expired_leases', count(*) filter (
      where t.status in ('claimed','in_progress')
        and t.lease_expires_at < pg_catalog.now()
    )
  )
  into v_queue
  from private.fam_agent_tasks as t;

  return pg_catalog.jsonb_build_object(
    'generated_at', pg_catalog.now(),
    'extensions', v_extensions,
    'extensions_ok', v_all_extensions_ok,
    'scheduled_jobs', v_jobs,
    'schedules_ok', v_all_schedules_ok,
    'rpc_permissions', v_rpcs,
    'rpc_permissions_ok', v_all_rpcs_ok,
    'queue', v_queue,
    'overall_ok', v_all_extensions_ok and v_all_schedules_ok and v_all_rpcs_ok
  );
end;
$function$;

revoke all on function public.get_fam_agent_task_system_health(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_fam_agent_task_system_health(uuid, text)
  to service_role;

create or replace function private.enqueue_fam_agent_system_health_check()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_check_date date := (pg_catalog.now() at time zone 'UTC')::date;
  v_inserted integer := 0;
begin
  insert into private.fam_agent_tasks (
    agent_key,
    task_type,
    title,
    description,
    priority,
    status,
    source,
    approval_required,
    payload,
    max_attempts
  )
  values (
    'technical',
    'system_health_check',
    'Ежедневная техническая проверка FAM',
    'Проверить только служебное состояние расширений базы, расписаний, RPC-разрешений и агрегированную очередь. Не читать пользовательские данные и не вносить изменения.',
    'normal',
    'queued',
    'scheduled_audit',
    false,
    pg_catalog.jsonb_build_object('check_date', pg_catalog.to_char(v_check_date, 'YYYY-MM-DD')),
    3
  )
  on conflict do nothing;

  get diagnostics v_inserted = row_count;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'check_date', v_check_date,
    'task_created', (v_inserted = 1)
  );
end;
$function$;

revoke all on function private.enqueue_fam_agent_system_health_check()
  from public, anon, authenticated, service_role;
grant execute on function private.enqueue_fam_agent_system_health_check()
  to postgres;

select cron.schedule(
  'fam-agent-technical-system-health',
  '10 6 * * *',
  'select private.enqueue_fam_agent_system_health_check();'
);
