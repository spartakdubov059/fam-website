-- TEST CANDIDATE ONLY. Not a migration. Preserve existing ACL, allowlist, leases and owner review policy.
-- Keep retries scoped to recent INSPECTOR infrastructure tasks and retire stale safe queue entries.
create or replace function public.claim_fam_agent_coder_tasks(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 7200
)
returns table(id uuid,task_key text,event_code text,page_area text,occurrences integer)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then raise exception 'invalid coder worker'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('fam-qwen-coder-queue-v1'));
  with stale_queued as (
    update private.fam_agent_tasks t
    set status='failed', claimed_by=null, claimed_at=null, lease_expires_at=null,
      finished_at=pg_catalog.now(),
      result_summary='Задача закрыта: техническое задание устарело в очереди.',
      updated_at=pg_catalog.now()
    where t.agent_key='technical' and t.task_type='coder_patch_request'
      and t.approval_required=false and t.source in ('system','scheduled_audit')
      and t.status='queued' and t.created_at < pg_catalog.now()-interval '7 days'
    returning t.id
  )
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  select s.id,'failed',p_worker_id,'Задача закрыта без запуска модели: возраст очереди превысил семь дней.'
  from stale_queued s;

  with retry_candidate as (
    select t.id from private.fam_agent_tasks t
    where t.agent_key='technical' and t.task_type='coder_patch_request'
      and t.approval_required=false and t.source in ('system','scheduled_audit')
      and t.status='failed'
      and t.payload->>'task_key'='audit_agent_infrastructure'
      and t.payload->>'event_code' in ('ci_workflow_failure','worker_queue_failure','worker_expired_lease','qwen_repeated_failure','qwen_stuck_run','synthetic_ci_workflow_failure')
      and t.created_at >= pg_catalog.now()-interval '7 days'
      and t.result_summary='Локальный анализатор завершился с ошибкой.'
      and t.attempt_count<t.max_attempts
      and not exists (
        select 1 from private.fam_agent_tasks active
        where active.id<>t.id and active.agent_key='technical'
          and active.task_type='coder_patch_request'
          and active.status in ('queued','claimed','in_progress')
      )
    order by case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,t.created_at,t.id
    for update skip locked limit 1
  ), retryable_failures as (
    update private.fam_agent_tasks t
    set status='queued', claimed_by=null, claimed_at=null, lease_expires_at=null,
      started_at=null, finished_at=null, available_at=pg_catalog.now(),
      result_summary='Повторная попытка поставлена в очередь после ограниченной ошибки запуска.',
      updated_at=pg_catalog.now()
    from retry_candidate c
    where t.id=c.id and t.status='failed'
    returning t.id
  )
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  select r.id,'retry_scheduled',p_worker_id,
    'Временный сбой запуска будет повторён в пределах разрешённого лимита.'
  from retryable_failures r;

  with exhausted as (
    update private.fam_agent_tasks t set status='failed',
      result_summary='Локальный анализатор исчерпал число попыток после истечения аренды.',
      claimed_by=null,claimed_at=null,lease_expires_at=null,finished_at=pg_catalog.now(),updated_at=pg_catalog.now()
    where t.agent_key='technical' and t.task_type='coder_patch_request' and t.approval_required=false
      and t.source in ('system','scheduled_audit') and t.claimed_by=p_worker_id
      and t.status in ('claimed','in_progress') and t.lease_expires_at<=pg_catalog.now()
      and t.attempt_count>=t.max_attempts returning t.id
  ) insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
    select e.id,'failed',p_worker_id,'Задача закрыта: аренда последней разрешённой попытки истекла.' from exhausted e;
  with recovered as (
    update private.fam_agent_tasks t set status='queued',claimed_by=null,claimed_at=null,lease_expires_at=null,
      started_at=null,finished_at=null,result_summary='Повторная попытка поставлена в очередь после истечения аренды.',updated_at=pg_catalog.now()
    where t.agent_key='technical' and t.task_type='coder_patch_request' and t.approval_required=false
      and t.source in ('system','scheduled_audit') and t.claimed_by=p_worker_id
      and t.status in ('claimed','in_progress') and t.lease_expires_at<=pg_catalog.now()
      and t.attempt_count<t.max_attempts returning t.id
  ) insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
    select r.id,'retry_scheduled',p_worker_id,'Истёк lease; задача возвращена в очередь для ограниченного повтора.' from recovered r;
  return query
  with candidates as (
    select t.id from private.fam_agent_tasks t
    where t.agent_key='technical' and t.task_type='coder_patch_request' and t.approval_required=false
      and t.source in ('system','scheduled_audit') and t.available_at<=pg_catalog.now()
      and t.attempt_count<t.max_attempts and t.status='queued'
      and not exists (
        select 1 from private.fam_agent_tasks active
        where active.agent_key='technical' and active.task_type='coder_patch_request'
          and active.status in ('claimed','in_progress')
      )
      and t.created_at >= pg_catalog.now()-interval '7 days'
      and pg_catalog.jsonb_typeof(t.payload)='object'
      and t.payload ?& array['task_key','event_code','page_area','occurrences']
      and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(t.payload))=4
      and t.payload->>'task_key' in ('audit_frontend_runtime','audit_client_resilience','audit_accessibility','audit_agent_infrastructure')
      and t.payload->>'event_code' in (
        'js_runtime','unhandled_rejection','supabase_sdk_unavailable','listings_load_failed',
        'notifications_load_failed','database_request_failed','auth_backend_failed',
        'ci_workflow_failure','worker_queue_failure','worker_expired_lease','qwen_repeated_failure','qwen_stuck_run','synthetic_ci_workflow_failure'
      )
      and t.payload->>'page_area' in ('auth','listings','notifications','database','other','agent_infrastructure')
      and pg_catalog.jsonb_typeof(t.payload->'occurrences')='number'
      and (t.payload->>'occurrences') ~ '^[0-9]{1,4}$'
      and (t.payload->>'occurrences')::integer between 1 and 1000
      and ((t.payload->>'task_key')='audit_agent_infrastructure') = ((t.payload->>'page_area')='agent_infrastructure')
    order by case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,t.created_at
    for update skip locked limit least(greatest(coalesce(p_limit,1),1),1)
  ), claimed as (
    update private.fam_agent_tasks t set status='claimed',claimed_by=p_worker_id,claimed_at=pg_catalog.now(),
      lease_expires_at=pg_catalog.now()+pg_catalog.make_interval(secs=>least(greatest(coalesce(p_lease_seconds,7200),300),7200)),
      attempt_count=t.attempt_count+1,started_at=null,
      result_summary='Ограниченное техническое задание принято локальным анализатором.',updated_at=pg_catalog.now()
    from candidates c where t.id=c.id returning t.id,t.payload
  ), logged as (
    insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
    select c.id,'claimed',p_worker_id,'Ограниченное техническое задание передано локальному анализатору.' from claimed c returning task_id
  ) select c.id,c.payload->>'task_key',c.payload->>'event_code',c.payload->>'page_area',
      (c.payload->>'occurrences')::integer from claimed c join logged l on l.task_id=c.id;
end;
$function$;

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

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('fam-qwen-coder-queue-v1'));
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
