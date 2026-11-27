-- TEST CANDIDATE ONLY. Not a migration. Serialize competing INSPECTOR enqueue calls across signal types.
-- Give the manually dispatched Qwen runtime smoke test its own cooldown key.
-- The signal remains allowlisted and receives the same two-attempt task budget.
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
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('fam-qwen-coder-queue-v1'));
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
