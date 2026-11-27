-- Bounded, allowlisted INSPECTOR -> Qwen enqueue path. Never stores raw workflow logs.
create table private.fam_agent_inspector_signals (
  event_id text primary key check (event_id ~ '^[a-z0-9:_-]{3,100}$'),
  signal_code text not null check (signal_code in (
    'ci_workflow_failure','worker_queue_failure','worker_expired_lease','qwen_repeated_failure','qwen_stuck_run','synthetic_ci_workflow_failure'
  )),
  signature text not null,
  outcome text not null check (outcome in ('queued','deduped','active_task')),
  task_id uuid references private.fam_agent_tasks(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now()
);

create index fam_agent_inspector_signals_signature_idx
  on private.fam_agent_inspector_signals(signature,created_at desc);
alter table private.fam_agent_inspector_signals enable row level security;
alter table private.fam_agent_inspector_signals force row level security;
revoke all on private.fam_agent_inspector_signals from public,anon,authenticated;
grant select,insert,update on private.fam_agent_inspector_signals to service_role;

create or replace function public.enqueue_fam_agent_inspector_task(
  p_signal_code text,
  p_event_id text,
  p_occurrences integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_signature text;
  v_task_id uuid;
begin
  if p_signal_code is null or p_signal_code not in (
    'ci_workflow_failure','worker_queue_failure','worker_expired_lease','qwen_repeated_failure','qwen_stuck_run','synthetic_ci_workflow_failure'
  ) or p_event_id is null or p_event_id !~ '^[a-z0-9:_-]{3,100}$'
    or p_occurrences is null or p_occurrences not between 1 and 1000 then
    raise exception 'invalid inspector signal';
  end if;

  v_signature := p_signal_code;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_signature));
  insert into private.fam_agent_inspector_signals(event_id,signal_code,signature,outcome)
  values (p_event_id,p_signal_code,v_signature,'active_task')
  on conflict (event_id) do nothing;
  if not found then
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','duplicate_event');
  end if;

  if exists (
    select 1 from private.fam_agent_inspector_signals s
    where s.signature=v_signature and s.outcome='queued'
      and s.created_at > pg_catalog.now() - interval '7 days'
  ) then
    update private.fam_agent_inspector_signals set outcome='deduped' where event_id=p_event_id;
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','signal_cooldown');
  end if;

  if exists (
    select 1 from private.fam_agent_tasks t
    where t.agent_key='technical' and t.task_type='coder_patch_request'
      and t.status in ('queued','claimed','in_progress')
  ) then
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','coder_task_already_active');
  end if;

  insert into private.fam_agent_tasks(
    agent_key,task_type,title,description,priority,status,source,approval_required,payload,max_attempts
  ) values (
    'technical','coder_patch_request','Проверка подтверждённого сигнала инфраструктуры агентов',
    'Проверить узкую область управляющей инфраструктуры по коду сигнала. Не читать журналы, пользовательские данные или секреты.',
    case when p_signal_code in ('worker_queue_failure','worker_expired_lease') then 'high' else 'normal' end,
    'queued','scheduled_audit',false,
    pg_catalog.jsonb_build_object(
      'task_key','audit_agent_infrastructure',
      'event_code',p_signal_code,
      'page_area','agent_infrastructure',
      'occurrences',p_occurrences
    ),
    2
  ) returning id into v_task_id;

  update private.fam_agent_inspector_signals
  set outcome='queued',task_id=v_task_id where event_id=p_event_id;
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary,metadata)
  values (v_task_id,'created','fam-agent-inspector','INSPECTOR поставил ограниченную техническую проверку в очередь.',
    pg_catalog.jsonb_build_object('stage','queued','signal_code',p_signal_code));
  return pg_catalog.jsonb_build_object('ok',true,'task_created',true,'task_id',v_task_id,'reason','queued');
end;
$function$;

revoke all on function public.enqueue_fam_agent_inspector_task(text,text,integer) from public,anon,authenticated;
grant execute on function public.enqueue_fam_agent_inspector_task(text,text,integer) to service_role;

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
revoke all on function public.claim_fam_agent_coder_tasks(text,integer,integer) from public,anon,authenticated;
grant execute on function public.claim_fam_agent_coder_tasks(text,integer,integer) to service_role;
