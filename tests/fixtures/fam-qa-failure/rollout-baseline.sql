-- Synthetic rehearsal only. Exact function definitions from repository; no production migration.
create or replace function public.advance_fam_agent_coder_task(
  p_task_id uuid,
  p_worker_id text,
  p_stage text,
  p_pr_number integer default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_expected text;
  v_summary text;
  v_event text := 'progress';
  v_status text := 'in_progress';
  v_updated uuid;
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then
    raise exception 'invalid coder worker';
  end if;
  case p_stage
    when 'model_generated' then
      v_expected := 'Задание принято локальным анализатором; независимая QA ещё не подтверждена.';
      v_summary := 'Модель подготовила предложение; независимая QA ещё не подтверждена.';
    when 'qa_passed' then
      v_expected := 'Модель подготовила предложение; независимая QA ещё не подтверждена.';
      v_summary := 'Независимая QA прошла; PR ещё не создан.';
    when 'pr_created' then
      v_expected := 'Независимая QA прошла; PR ещё не создан.';
      v_summary := 'PR создан после независимой QA; ожидает решения владельца.';
    when 'qa_failed' then
      v_expected := 'Независимая QA прошла; PR ещё не создан.';
      v_summary := 'Независимая QA не прошла; изменение не считается выполненным.';
      v_status := 'blocked';
      v_event := 'blocked';
    when 'model_no_patch' then
      v_expected := 'Задание принято локальным анализатором; независимая QA ещё не подтверждена.';
      v_summary := 'Локальная модель не предложила подтверждённое исправление.';
      v_status := 'completed';
      v_event := 'completed';
    when 'model_failed' then
      v_expected := 'Задание принято локальным анализатором; независимая QA ещё не подтверждена.';
      v_summary := 'Локальный анализатор завершился с ошибкой.';
      v_status := 'failed';
      v_event := 'failed';
    when 'model_blocked' then
      v_expected := 'Задание принято локальным анализатором; независимая QA ещё не подтверждена.';
      v_summary := 'Задание остановлено защитными ограничениями.';
      v_status := 'blocked';
      v_event := 'blocked';
    else
      raise exception 'invalid coder lifecycle stage';
  end case;
  if p_stage = 'pr_created' and
      (p_pr_number is null or p_pr_number < 1 or p_pr_number > 99999999) then
    raise exception 'invalid pull request number';
  end if;

  update private.fam_agent_tasks as t
  set status = v_status,
      result_summary = v_summary,
      finished_at = case when v_status = 'completed' then pg_catalog.now() else null end,
      lease_expires_at = case
        when v_status in ('completed','failed','blocked') or p_stage = 'pr_created' then null
        when p_stage in ('model_generated','qa_passed') then
          pg_catalog.now() + pg_catalog.make_interval(secs => 7200)
        else t.lease_expires_at
      end,
      updated_at = pg_catalog.now()
  where t.id = p_task_id and t.agent_key = 'technical'
    and t.task_type = 'coder_patch_request' and t.approval_required = false
    and t.source in ('system','scheduled_audit') and t.claimed_by = p_worker_id
    and t.status = 'in_progress' and t.result_summary = v_expected
    and t.lease_expires_at > pg_catalog.now()
  returning t.id into v_updated;
  if v_updated is null then return false; end if;
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary,metadata)
  values (v_updated,v_event,p_worker_id,v_summary,
    case when p_pr_number is null then pg_catalog.jsonb_build_object('stage',p_stage)
      else pg_catalog.jsonb_build_object('stage',p_stage,'pr_number',p_pr_number) end);
  if v_status in ('completed','failed','blocked') or p_stage = 'pr_created' then
    update private.fam_agent_tasks set claimed_by = null, claimed_at = null
    where id = v_updated;
  end if;
  return true;
end;
$function$;

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
  if p_signal_code='synthetic_ci_workflow_failure' and p_event_id like 'runtime_smoke:%' then
    v_signature := p_signal_code || ':runtime_smoke';
  end if;
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
