-- Secure, allowlisted bridge for the local Qwen coding agent.
-- This migration is proposed only; do not apply to production without explicit approval.

create or replace function public.claim_fam_agent_coder_tasks(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 1800
)
returns table (
  id uuid,
  task_key text,
  event_code text,
  page_area text,
  occurrences integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then
    raise exception 'invalid coder worker';
  end if;

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
      and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(t.payload)) = 4
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
    returning t.id, t.payload
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
    (c.payload->>'occurrences')::integer
  from claimed as c
  join logged as l on l.task_id = c.id;
end;
$function$;

create or replace function public.finish_fam_agent_coder_task(
  p_task_id uuid,
  p_worker_id text,
  p_result_code text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_status text;
  v_summary text;
  v_updated uuid;
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then
    raise exception 'invalid coder worker';
  end if;

  case p_result_code
    when 'model_completed' then
      v_status := 'completed';
      v_summary := 'Локальная модель завершила анализ; изменения ожидают независимой проверки.';
    when 'model_no_patch' then
      v_status := 'completed';
      v_summary := 'Локальная модель не предложила подтверждённое исправление.';
    when 'model_failed' then
      v_status := 'failed';
      v_summary := 'Локальный анализатор завершился с ошибкой.';
    when 'model_blocked' then
      v_status := 'blocked';
      v_summary := 'Задание остановлено защитными ограничениями.';
    else
      raise exception 'invalid coder result code';
  end case;

  update private.fam_agent_tasks as t
  set status = v_status,
      result_summary = v_summary,
      claimed_by = null,
      lease_expires_at = null,
      finished_at = case when v_status in ('completed','failed') then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where t.id = p_task_id
    and t.agent_key = 'technical'
    and t.task_type = 'coder_patch_request'
    and t.approval_required = false
    and t.claimed_by = p_worker_id
    and t.status = 'claimed'
    and t.lease_expires_at > pg_catalog.now()
  returning t.id into v_updated;

  if v_updated is null then
    return false;
  end if;

  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  values (v_updated,v_status,p_worker_id,v_summary);

  return true;
end;
$function$;

revoke all on function public.claim_fam_agent_coder_tasks(text,integer,integer) from public,anon,authenticated;
revoke all on function public.finish_fam_agent_coder_task(uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_fam_agent_coder_tasks(text,integer,integer) to service_role;
grant execute on function public.finish_fam_agent_coder_task(uuid,text,text) to service_role;

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
begin
  select c.event_code,c.page_area,sum(c.event_count)::integer as occurrences
  into v_event
  from private.fam_site_error_counts as c
  where c.hour_bucket >= pg_catalog.now() - interval '24 hours'
    and c.event_code in ('js_runtime','unhandled_rejection','listings_load_failed')
  group by c.event_code,c.page_area
  having sum(c.event_count) >= 3
  order by sum(c.event_count) desc,c.event_code,c.page_area
  limit 1;

  if not found then
    return jsonb_build_object('ok',true,'task_created',false,'reason','no_threshold_event');
  end if;

  v_task_key := case
    when v_event.event_code in ('js_runtime','unhandled_rejection') then 'audit_frontend_runtime'
    when v_event.event_code = 'listings_load_failed' then 'audit_client_resilience'
    else 'audit_accessibility'
  end;

  if exists (
    select 1 from private.fam_agent_tasks as t
    where t.agent_key='technical'
      and t.task_type='coder_patch_request'
      and t.status in ('queued','claimed','in_progress')
  ) then
    return jsonb_build_object('ok',true,'task_created',false,'reason','coder_task_already_active');
  end if;

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
      'occurrences',least(greatest(v_event.occurrences,0),1000)
    ),
    2
  ) returning id into v_task_id;

  return jsonb_build_object('ok',true,'task_created',true,'task_id',v_task_id);
end;
$function$;

revoke all on function private.enqueue_fam_agent_coder_task() from public,anon,authenticated;
grant execute on function private.enqueue_fam_agent_coder_task() to postgres,service_role;
