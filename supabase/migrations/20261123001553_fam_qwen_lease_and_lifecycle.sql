-- Bounded lease and explicit lifecycle for the Qwen technical queue.
-- The RPCs are invoker-only and callable only by service_role through the bridge.

create or replace function public.start_fam_agent_coder_task(
  p_task_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 1800
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare v_updated uuid;
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then
    raise exception 'invalid coder worker';
  end if;
  update private.fam_agent_tasks as t
  set status = 'in_progress',
      started_at = coalesce(t.started_at, pg_catalog.now()),
      lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(
        secs => least(greatest(coalesce(p_lease_seconds,1800),300),1800)),
      result_summary = 'Задание принято локальным анализатором; независимая QA ещё не подтверждена.',
      updated_at = pg_catalog.now()
  where t.id = p_task_id and t.agent_key = 'technical'
    and t.task_type = 'coder_patch_request' and t.approval_required = false
    and t.source in ('system','scheduled_audit') and t.claimed_by = p_worker_id
    and t.status = 'claimed' and t.lease_expires_at > pg_catalog.now()
  returning t.id into v_updated;
  if v_updated is null then return false; end if;
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  values (v_updated,'started',p_worker_id,'Локальный анализ начат с ограниченной арендой.');
  return true;
end;
$function$;

create or replace function public.heartbeat_fam_agent_coder_task(
  p_task_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 1800
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare v_updated uuid;
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then
    raise exception 'invalid coder worker';
  end if;
  update private.fam_agent_tasks as t
  set lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(
        secs => least(greatest(coalesce(p_lease_seconds,1800),300),1800)),
      updated_at = pg_catalog.now()
  where t.id = p_task_id and t.agent_key = 'technical'
    and t.task_type = 'coder_patch_request' and t.approval_required = false
    and t.source in ('system','scheduled_audit') and t.claimed_by = p_worker_id
    and t.status = 'in_progress'
    and t.result_summary in (
      'Задание принято локальным анализатором; независимая QA ещё не подтверждена.',
      'Модель подготовила предложение; независимая QA ещё не подтверждена.',
      'Независимая QA прошла; PR ещё не создан.'
    )
    and t.lease_expires_at > pg_catalog.now()
  returning t.id into v_updated;
  if v_updated is null then return false; end if;
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  values (v_updated,'progress',p_worker_id,'Активный локальный анализ подтвердил lease heartbeat.');
  return true;
end;
$function$;

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
  set status = v_status, result_summary = v_summary,
      claimed_by = null, claimed_at = null, lease_expires_at = null,
      finished_at = case when v_status in ('completed','failed') then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where t.id = p_task_id and t.agent_key = 'technical'
    and t.task_type = 'coder_patch_request' and t.approval_required = false
    and t.source in ('system','scheduled_audit') and t.claimed_by = p_worker_id
    and t.status in ('claimed','in_progress') and t.lease_expires_at > pg_catalog.now()
  returning t.id into v_updated;
  if v_updated is null then return false; end if;
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  values (v_updated,v_status,p_worker_id,v_summary);
  return true;
end;
$function$;

revoke all on function public.start_fam_agent_coder_task(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.heartbeat_fam_agent_coder_task(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.advance_fam_agent_coder_task(uuid,text,text,integer) from public,anon,authenticated;
revoke all on function public.finish_fam_agent_coder_task(uuid,text,text) from public,anon,authenticated;
grant execute on function public.start_fam_agent_coder_task(uuid,text,integer) to service_role;
grant execute on function public.heartbeat_fam_agent_coder_task(uuid,text,integer) to service_role;
grant execute on function public.advance_fam_agent_coder_task(uuid,text,text,integer) to service_role;
grant execute on function public.finish_fam_agent_coder_task(uuid,text,text) to service_role;
