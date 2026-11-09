-- Safe database-side FAM queue scheduler.
-- This runner intentionally handles only quality / queue_health_check tasks
-- with approval_required=false. It never reads personal content or mutates user records.

create unique index if not exists fam_agent_task_daily_schedule_key_uidx
  on private.fam_agent_tasks ((payload->>'schedule_key'))
  where source = 'scheduled_audit'
    and agent_key = 'quality'
    and task_type = 'queue_health_check'
    and (payload ? 'schedule_key');

create or replace function private.enqueue_fam_agent_daily_queue_check()
returns uuid
language plpgsql
set search_path = ''
as $function$
declare
  v_task_id uuid;
  v_schedule_key text := 'fam-queue-health-' ||
    pg_catalog.to_char((pg_catalog.now() at time zone 'UTC')::date, 'YYYY-MM-DD');
begin
  insert into private.fam_agent_tasks (
    agent_key, task_type, title, description, priority, status, source,
    approval_required, payload, max_attempts
  )
  values (
    'quality',
    'queue_health_check',
    'Ежедневная техническая проверка очереди FAM',
    'Проверить состояние закрытой очереди заданий FAM: количество ожидающих, выполняемых и завершённых задач. Не открывать пользовательские данные и не изменять аккаунты, объявления или сообщения.',
    'low',
    'queued',
    'scheduled_audit',
    false,
    pg_catalog.jsonb_build_object('schedule_key', v_schedule_key),
    2
  )
  on conflict ((payload->>'schedule_key'))
    where source = 'scheduled_audit'
      and agent_key = 'quality'
      and task_type = 'queue_health_check'
      and (payload ? 'schedule_key')
  do nothing
  returning id into v_task_id;

  if v_task_id is null then
    select t.id into v_task_id
    from private.fam_agent_tasks as t
    where t.source = 'scheduled_audit'
      and t.agent_key = 'quality'
      and t.task_type = 'queue_health_check'
      and t.payload->>'schedule_key' = v_schedule_key
    order by t.created_at
    limit 1;
  else
    insert into private.fam_agent_task_events (task_id, event_type, actor, summary, metadata)
    values (
      v_task_id, 'created', 'fam-db-scheduler',
      'Добавлена ежедневная безопасная проверка очереди.',
      pg_catalog.jsonb_build_object('schedule_key', v_schedule_key)
    );
  end if;

  return v_task_id;
end;
$function$;

create or replace function private.process_fam_agent_safe_queue(p_limit integer default 3)
returns integer
language plpgsql
set search_path = ''
as $function$
declare
  v_task record;
  v_summary text;
  v_waiting integer;
  v_running integer;
  v_completed integer;
  v_blocked integer;
  v_failed integer;
  v_processed integer := 0;
begin
  for v_task in
    select t.id
    from private.fam_agent_tasks as t
    where t.status = 'queued'
      and t.approval_required = false
      and t.agent_key = 'quality'
      and t.task_type = 'queue_health_check'
      and t.available_at <= pg_catalog.now()
      and t.attempt_count < t.max_attempts
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
  loop
    update private.fam_agent_tasks as t
    set status = 'claimed',
        claimed_by = 'fam-db-safe-queue-worker',
        claimed_at = pg_catalog.now(),
        lease_expires_at = pg_catalog.now() + interval '2 minutes',
        attempt_count = t.attempt_count + 1,
        started_at = coalesce(t.started_at, pg_catalog.now()),
        updated_at = pg_catalog.now()
    where t.id = v_task.id;

    insert into private.fam_agent_task_events (task_id, event_type, actor, summary)
    values (
      v_task.id, 'claimed', 'fam-db-safe-queue-worker',
      'Безопасная техническая задача взята внутренним обработчиком.'
    );

    -- Only queue status counters are inspected. Payloads and user content are never read.
    select
      count(*) filter (where status = 'queued')::integer,
      count(*) filter (where status in ('claimed', 'in_progress'))::integer,
      count(*) filter (where status = 'completed')::integer,
      count(*) filter (where status = 'blocked')::integer,
      count(*) filter (where status = 'failed')::integer
    into v_waiting, v_running, v_completed, v_blocked, v_failed
    from private.fam_agent_tasks;

    v_summary := pg_catalog.format(
      'Техническая проверка очереди завершена. Ожидают: %s; выполняются: %s; завершены: %s; заблокированы: %s; ошибки: %s. Пользовательские данные не запрашивались.',
      v_waiting, v_running, v_completed, v_blocked, v_failed
    );

    update private.fam_agent_tasks as t
    set status = 'completed',
        result_summary = v_summary,
        claimed_by = null,
        lease_expires_at = null,
        finished_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where t.id = v_task.id
      and t.claimed_by = 'fam-db-safe-queue-worker'
      and t.status = 'claimed';

    insert into private.fam_agent_task_events (task_id, event_type, actor, summary)
    values (v_task.id, 'completed', 'fam-db-safe-queue-worker', v_summary);

    v_processed := v_processed + 1;
  end loop;

  return v_processed;
end;
$function$;

revoke all on function private.enqueue_fam_agent_daily_queue_check() from public, anon, authenticated;
revoke all on function private.process_fam_agent_safe_queue(integer) from public, anon, authenticated;
grant execute on function private.enqueue_fam_agent_daily_queue_check() to postgres;
grant execute on function private.process_fam_agent_safe_queue(integer) to postgres;

comment on function private.enqueue_fam_agent_daily_queue_check() is
  'Queues one safe, content-free technical health check per UTC day. PostgreSQL cron only.';
comment on function private.process_fam_agent_safe_queue(integer) is
  'Processes only allowlisted quality queue_health_check tasks with approval_required=false. Does not read user data or change user content.';

select cron.schedule(
  'fam-agent-enqueue-daily-queue-check',
  '5 6 * * *',
  'select private.enqueue_fam_agent_daily_queue_check();'
);

select cron.schedule(
  'fam-agent-safe-queue-worker',
  '*/5 * * * *',
  'select private.process_fam_agent_safe_queue(3);'
);

-- Create today's task once; the unique schedule key makes the operation idempotent.
select private.enqueue_fam_agent_daily_queue_check();
