-- Retry a transient local coder failure at most once and deduplicate repeated
-- producer signals. This migration changes queue control metadata only.

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
  v_has_retry boolean;
  v_updated uuid;
  v_event_type text;
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then
    raise exception 'invalid coder worker';
  end if;

  select t.attempt_count < t.max_attempts
    into v_has_retry
  from private.fam_agent_tasks as t
  where t.id = p_task_id
    and t.agent_key = 'technical'
    and t.task_type = 'coder_patch_request'
    and t.approval_required = false
    and t.source in ('system', 'scheduled_audit')
    and t.claimed_by = p_worker_id
    and t.status = 'claimed'
    and t.lease_expires_at > pg_catalog.now()
  for update;

  if not found then
    return false;
  end if;

  case p_result_code
    when 'model_completed' then
      v_status := 'completed';
      v_summary := 'Локальная модель подготовила результат; он ожидает независимой проверки.';
    when 'model_no_patch' then
      v_status := 'completed';
      v_summary := 'Локальная модель не предложила подтверждённое исправление.';
    when 'model_failed' then
      if v_has_retry then
        v_status := 'queued';
        v_summary := 'Временная ошибка локального анализатора; назначена одна повторная попытка.';
      else
        v_status := 'failed';
        v_summary := 'Локальный анализатор исчерпал разрешённое число попыток.';
      end if;
    when 'model_blocked' then
      v_status := 'blocked';
      v_summary := 'Задание остановлено защитными ограничениями.';
    else
      raise exception 'invalid coder result code';
  end case;

  update private.fam_agent_tasks as t
  set status = v_status,
      result_summary = v_summary,
      available_at = case
        when v_status = 'queued' and t.available_at > pg_catalog.now() + interval '30 minutes'
          then t.available_at
        when v_status = 'queued'
          then pg_catalog.now() + interval '30 minutes'
        else t.available_at
      end,
      claimed_by = null,
      claimed_at = null,
      lease_expires_at = null,
      finished_at = case when v_status in ('completed','failed') then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where t.id = p_task_id
    and t.agent_key = 'technical'
    and t.task_type = 'coder_patch_request'
    and t.approval_required = false
    and t.source in ('system', 'scheduled_audit')
    and t.claimed_by = p_worker_id
    and t.status = 'claimed'
    and t.lease_expires_at > pg_catalog.now()
  returning t.id into v_updated;

  if v_updated is null then
    return false;
  end if;

  v_event_type := case when v_status = 'queued' then 'retry_scheduled' else v_status end;
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  values (v_updated,v_event_type,p_worker_id,v_summary);

  return true;
end;
$function$;

revoke all on function public.finish_fam_agent_coder_task(uuid,text,text) from public,anon,authenticated;
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
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','no_threshold_event');
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
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','coder_task_already_active');
  end if;

  -- A recurring telemetry signal can create at most one new coding task per
  -- signature in seven days, including after its bounded retry has failed.
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

  return pg_catalog.jsonb_build_object('ok',true,'task_created',true,'task_id',v_task_id);
end;
$function$;

revoke all on function private.enqueue_fam_agent_coder_task() from public,anon,authenticated;
grant execute on function private.enqueue_fam_agent_coder_task() to postgres,service_role;

-- Recover at most one recent, signature-unique task that the previous bridge
-- marked failed on a transient model error before the bounded retry was added.
-- Exact summary matching, attempt bounds, source/approval allowlists, active
-- duplicate suppression, a seven-day age bound, and retry-event idempotency
-- keep this one-time backfill narrow and safe.
with locked_candidates as (
  select t.id,t.payload,t.created_at
  from private.fam_agent_tasks as t
  where t.agent_key='technical'
    and t.task_type='coder_patch_request'
    and t.approval_required=false
    and t.source in ('system','scheduled_audit')
    and t.status='failed'
    and t.result_summary='Локальный анализатор завершился с ошибкой.'
    and t.created_at >= pg_catalog.now()-interval '7 days'
    and t.attempt_count < t.max_attempts
    and t.payload ?& array['task_key','event_code','page_area','occurrences']
    and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(t.payload)) = 4
    and t.payload->>'task_key' in ('audit_frontend_runtime','audit_client_resilience','audit_accessibility')
    and t.payload->>'event_code' in ('js_runtime','unhandled_rejection','listings_load_failed')
    and t.payload->>'page_area' in ('auth','listings','notifications','database','other')
    and pg_catalog.jsonb_typeof(t.payload->'occurrences')='number'
    and (t.payload->>'occurrences') ~ '^[0-9]{1,4}$'
    and (t.payload->>'occurrences')::integer between 0 and 1000
    and not exists (
      select 1 from private.fam_agent_tasks as active
      where active.agent_key='technical'
        and active.task_type='coder_patch_request'
        and active.approval_required=false
        and active.source in ('system','scheduled_audit')
        and active.status in ('queued','claimed','in_progress')
        and active.payload->>'task_key'=t.payload->>'task_key'
        and active.payload->>'event_code'=t.payload->>'event_code'
        and active.payload->>'page_area'=t.payload->>'page_area'
    )
    and not exists (
      select 1
      from private.fam_agent_task_events as prior_retry
      join private.fam_agent_tasks as prior_task on prior_task.id=prior_retry.task_id
      where prior_retry.event_type='retry_scheduled'
        and prior_retry.created_at >= pg_catalog.now()-interval '7 days'
        and prior_task.agent_key='technical'
        and prior_task.task_type='coder_patch_request'
        and prior_task.approval_required=false
        and prior_task.source in ('system','scheduled_audit')
        and prior_task.payload->>'task_key'=t.payload->>'task_key'
        and prior_task.payload->>'event_code'=t.payload->>'event_code'
        and prior_task.payload->>'page_area'=t.payload->>'page_area'
    )
  order by t.created_at desc,t.id desc
  for update of t skip locked
), ranked_candidates as (
  select id,
    pg_catalog.row_number() over (
      partition by payload->>'task_key',payload->>'event_code',payload->>'page_area'
      order by created_at desc,id desc
    ) as signature_rank
  from locked_candidates
), reopened as (
  update private.fam_agent_tasks as t
  set status='queued',
      result_summary='Недавняя временная ошибка локальной модели; назначена одна повторная попытка.',
      available_at=pg_catalog.now()+interval '30 minutes',
      claimed_by=null,
      claimed_at=null,
      lease_expires_at=null,
      finished_at=null,
      updated_at=pg_catalog.now()
  where t.id in (select id from ranked_candidates where signature_rank=1)
    and t.status='failed'
    and t.attempt_count < t.max_attempts
  returning t.id
)
insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
select id,'retry_scheduled','fam-agent-retry-migration-v1',
  'Для недавней временной ошибки назначена одна повторная попытка.'
from reopened;
