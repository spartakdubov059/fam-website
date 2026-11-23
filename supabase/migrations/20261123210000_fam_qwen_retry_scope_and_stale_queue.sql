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

  with retryable_failures as (
    update private.fam_agent_tasks t
    set status='queued', claimed_by=null, claimed_at=null, lease_expires_at=null,
      started_at=null, finished_at=null, available_at=pg_catalog.now(),
      result_summary='Повторная попытка поставлена в очередь после ограниченной ошибки запуска.',
      updated_at=pg_catalog.now()
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
