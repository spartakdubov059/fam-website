create unique index if not exists fam_agent_tasks_orchestrator_daily_digest_date_uidx
  on private.fam_agent_tasks ((payload ->> 'report_date'))
  where agent_key = 'orchestrator'
    and task_type = 'daily_report_digest';

create or replace function public.get_fam_agent_task_daily_digest(
  p_task_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_report_date date;
  v_digest jsonb;
begin
  if p_task_id is null
     or p_worker_id is null
     or pg_catalog.char_length(pg_catalog.btrim(p_worker_id)) not between 1 and 80 then
    return null;
  end if;

  select
    case
      when t.payload ->> 'report_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        then (t.payload ->> 'report_date')::date
      else null
    end
  into v_report_date
  from private.fam_agent_tasks as t
  where t.id = p_task_id
    and t.agent_key = 'orchestrator'
    and t.task_type = 'daily_report_digest'
    and t.approval_required = false
    and t.claimed_by = p_worker_id
    and t.status = 'claimed'
    and t.lease_expires_at > pg_catalog.now();

  if v_report_date is null then
    return null;
  end if;

  select pg_catalog.jsonb_build_object(
    'report_date', r.report_date,
    'generated_at', r.generated_at,
    'active_listings',
      coalesce(nullif(r.metrics #>> '{listings,active}', '')::integer, 0),
    'new_listings_24h',
      coalesce(nullif(r.metrics #>> '{listings,new_24h}', '')::integer, 0),
    'pending_ideas',
      coalesce(nullif(r.metrics #>> '{ideas,pending}', '')::integer, 0),
    'queued_tasks',
      coalesce(nullif(r.metrics #>> '{tasks,queued}', '')::integer, 0),
    'completed_tasks_24h',
      coalesce(nullif(r.metrics #>> '{tasks,completed_24h}', '')::integer, 0),
    'blocked_tasks_24h',
      coalesce(nullif(r.metrics #>> '{tasks,blocked_24h}', '')::integer, 0),
    'failed_tasks_24h',
      coalesce(nullif(r.metrics #>> '{tasks,failed_24h}', '')::integer, 0)
  )
  into v_digest
  from private.fam_agent_daily_reports as r
  where r.report_date = v_report_date;

  return v_digest;
end;
$function$;

revoke all on function public.get_fam_agent_task_daily_digest(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_fam_agent_task_daily_digest(uuid, text)
  to service_role;

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

create or replace function private.refresh_and_enqueue_fam_agent_daily_digest()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_report_date date := (pg_catalog.now() at time zone 'UTC')::date;
  v_inserted integer := 0;
begin
  perform private.refresh_fam_agent_daily_report();

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
    'orchestrator',
    'daily_report_digest',
    'Ежедневная операционная сводка FAM',
    'Обработать агрегированные рабочие показатели за дату из payload. Не читать и не передавать личные данные, сообщения или содержимое объявлений.',
    'normal',
    'queued',
    'scheduled_audit',
    false,
    pg_catalog.jsonb_build_object('report_date', pg_catalog.to_char(v_report_date, 'YYYY-MM-DD')),
    3
  )
  on conflict do nothing;

  get diagnostics v_inserted = row_count;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'report_date', v_report_date,
    'task_created', (v_inserted = 1)
  );
end;
$function$;

revoke all on function private.refresh_and_enqueue_fam_agent_daily_digest()
  from public, anon, authenticated, service_role;
grant execute on function private.refresh_and_enqueue_fam_agent_daily_digest()
  to postgres;

select cron.schedule(
  'fam-agent-orchestrator-daily-digest',
  '5 6 * * *',
  'select private.refresh_and_enqueue_fam_agent_daily_digest();'
);
