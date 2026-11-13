-- Prevent a recurring telemetry signature from enqueueing a new coder task
-- every day after the previous task completes or exhausts its bounded retry.
-- Serialize producer invocations so concurrent cron/manual calls cannot race
-- past the active-task and cooldown checks.
create or replace function private.enqueue_fam_agent_coder_task()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_event record;
  v_task_key text;
  v_task_id uuid;
  v_event_summary text;
  v_previous_attempts integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('fam-agent-coder-task-producer')::bigint
  );

  select c.event_code,c.page_area,sum(c.event_count)::integer as occurrences,
         pg_catalog.max(c.hour_bucket) as observed_hour
  into v_event
  from private.fam_site_error_counts as c
  where c.hour_bucket >= pg_catalog.now() - interval '24 hours'
    and c.event_code in ('js_runtime','unhandled_rejection','listings_load_failed')
  group by c.event_code,c.page_area
  having sum(c.event_count) >= 3
  order by sum(c.event_count) desc,c.event_code,c.page_area
  limit 1;

  if not found then
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','no_threshold_event');
  end if;

  v_task_key := case
    when v_event.event_code in ('js_runtime','unhandled_rejection') then 'audit_frontend_runtime'
    when v_event.event_code = 'listings_load_failed' then 'audit_client_resilience'
    else 'audit_accessibility'
  end;

  v_event_summary := case v_event.event_code
    when 'js_runtime' then 'Ошибка выполнения JavaScript'
    when 'unhandled_rejection' then 'Необработанное отклонение Promise'
    when 'listings_load_failed' then 'Не удалось загрузить объявления'
    else 'Техническое событие интерфейса'
  end;

  if exists (
    select 1 from private.fam_agent_tasks as t
    where t.agent_key='technical'
      and t.task_type='coder_patch_request'
      and t.status in ('queued','claimed','in_progress')
  ) then
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','coder_task_already_active');
  end if;

  if exists (
    select 1 from private.fam_agent_tasks as t
    where t.agent_key='technical'
      and t.task_type='coder_patch_request'
      and t.source in ('system','scheduled_audit')
      and t.created_at >= pg_catalog.now() - interval '7 days'
      and t.payload->>'task_key' = v_task_key
      and t.payload->>'event_code' = v_event.event_code
      and t.payload->>'page_area' = v_event.page_area
  ) then
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','matching_coder_task_cooldown');
  end if;

  select least(coalesce(sum(t.attempt_count),0),20)::integer
    into v_previous_attempts
  from private.fam_agent_tasks as t
  where t.agent_key='technical'
    and t.task_type='coder_patch_request'
    and t.source in ('system','scheduled_audit')
    and t.created_at >= pg_catalog.now() - interval '30 days'
    and t.payload->>'task_key' = v_task_key
    and t.payload->>'event_code' = v_event.event_code
    and t.payload->>'page_area' = v_event.page_area;

  insert into private.fam_agent_tasks(
    agent_key,task_type,title,description,priority,status,source,
    approval_required,payload,max_attempts
  ) values (
    'technical',
    'coder_patch_request',
    'Безопасный анализ технического события FAM',
    'Провести только локальный анализ публичного клиентского кода по заранее разрешённой теме. Не читать пользовательские данные и не менять production.',
    'normal',
    'queued',
    'scheduled_audit',
    false,
    pg_catalog.jsonb_build_object(
      'task_key',v_task_key,
      'event_code',v_event.event_code,
      'page_area',v_event.page_area,
      'occurrences',least(greatest(v_event.occurrences,0),1000),
      'event_summary',v_event_summary,
      'observed_hour',pg_catalog.to_char(v_event.observed_hour at time zone 'UTC','YYYY-MM-DD"T"HH24:00:00"Z"'),
      'previous_attempts',v_previous_attempts
    ),
    2
  ) returning id into v_task_id;

  return pg_catalog.jsonb_build_object('ok',true,'task_created',true,'task_id',v_task_id);
end;
$function$;

revoke all on function private.enqueue_fam_agent_coder_task() from public,anon,authenticated;
grant execute on function private.enqueue_fam_agent_coder_task() to postgres,service_role;


-- PostgreSQL cannot replace a TABLE-returning function with a different OUT row type.
-- The RPC signature is unchanged, so drop and recreate it atomically in this migration.
drop function if exists public.claim_fam_agent_coder_tasks(text,integer,integer);

create function public.claim_fam_agent_coder_tasks(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 7200
)
returns table (
  id uuid,
  task_key text,
  event_code text,
  page_area text,
  occurrences integer,
  event_summary text,
  observed_hour text,
  previous_attempts integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then
    raise exception 'invalid coder worker';
  end if;

  -- An expired lease on the final permitted attempt must become a terminal failure.
  -- Without this cleanup such a task remains claimed forever and is never claimable again.
  with exhausted as (
    update private.fam_agent_tasks as t
    set status = 'failed',
        result_summary = 'Локальный анализатор исчерпал число попыток после истечения аренды.',
        claimed_by = null,
        claimed_at = null,
        lease_expires_at = null,
        finished_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where t.agent_key = 'technical'
      and t.task_type = 'coder_patch_request'
      and t.approval_required = false
      and t.source in ('system', 'scheduled_audit')
      and t.claimed_by = p_worker_id
      and t.status in ('claimed', 'in_progress')
      and t.lease_expires_at <= pg_catalog.now()
      and t.attempt_count >= t.max_attempts
    returning t.id
  )
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  select
    e.id,
    'failed',
    'fam-agent-qwen-coder-v1',
    'Задание автоматически закрыто: истекла аренда последней разрешённой попытки.'
  from exhausted as e;

  return query
  with candidates as (
    select t.id
    from private.fam_agent_tasks as t
    where t.agent_key = 'technical'
      and t.task_type = 'coder_patch_request'
      and t.approval_required = false
      and t.source in ('system', 'scheduled_audit')
      and t.available_at <= pg_catalog.now()
      and t.attempt_count < t.max_attempts
      and (
        t.status = 'queued'
        or (t.status in ('claimed', 'in_progress') and t.lease_expires_at < pg_catalog.now())
      )
      and pg_catalog.jsonb_typeof(t.payload) = 'object'
      and t.payload ?& array['task_key','event_code','page_area','occurrences']
      and (
        (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(t.payload)) = 4
        or (
          (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(t.payload)) = 7
          and t.payload ?& array['event_summary','observed_hour','previous_attempts']
          and t.payload->>'event_summary' in (
            'Ошибка выполнения JavaScript',
            'Необработанное отклонение Promise',
            'Не удалось загрузить объявления'
          )
          and t.payload->>'observed_hour' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00:00Z$'
          and pg_catalog.jsonb_typeof(t.payload->'previous_attempts') = 'number'
          and (t.payload->>'previous_attempts') ~ '^[0-9]{1,2}$'
          and (t.payload->>'previous_attempts')::integer between 0 and 20
        )
      )
      and t.payload->>'task_key' in (
        'audit_frontend_runtime',
        'audit_client_resilience',
        'audit_accessibility'
      )
      and t.payload->>'event_code' in (
        'js_runtime','unhandled_rejection','supabase_sdk_unavailable',
        'listings_load_failed','notifications_load_failed',
        'database_request_failed','auth_backend_failed'
      )
      and t.payload->>'page_area' in ('auth','listings','notifications','database','other')
      and pg_catalog.jsonb_typeof(t.payload->'occurrences') = 'number'
      and (t.payload->>'occurrences') ~ '^[0-9]{1,4}$'
      and (t.payload->>'occurrences')::integer between 0 and 1000
    order by
      case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
      t.created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 1)
  ), claimed as (
    update private.fam_agent_tasks as t
    set status = 'claimed',
        claimed_by = p_worker_id,
        claimed_at = pg_catalog.now(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(
          secs => least(greatest(coalesce(p_lease_seconds, 7200), 300), 7200)
        ),
        attempt_count = t.attempt_count + 1,
        updated_at = pg_catalog.now()
    from candidates as c
    where t.id = c.id
    returning t.id, t.payload, t.created_at
  ), logged as (
    insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
    select c.id,'claimed',p_worker_id,'Ограниченное техническое задание передано локальному анализатору.'
    from claimed as c
    returning task_id
  )
  select
    c.id,
    c.payload->>'task_key',
    c.payload->>'event_code',
    c.payload->>'page_area',
    (c.payload->>'occurrences')::integer,
    coalesce(c.payload->>'event_summary',case c.payload->>'event_code'
      when 'js_runtime' then 'Ошибка выполнения JavaScript'
      when 'unhandled_rejection' then 'Необработанное отклонение Promise'
      when 'listings_load_failed' then 'Не удалось загрузить объявления'
      else 'Техническое событие интерфейса'
    end),
    coalesce(nullif(c.payload->>'observed_hour',''),pg_catalog.to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:00:00"Z"')),
    coalesce(nullif(c.payload->>'previous_attempts','')::integer,0)
  from claimed as c
  join logged as l on l.task_id = c.id;
end;
$function$;

revoke all on function public.claim_fam_agent_coder_tasks(text,integer,integer) from public,anon,authenticated;
grant execute on function public.claim_fam_agent_coder_tasks(text,integer,integer) to service_role;
