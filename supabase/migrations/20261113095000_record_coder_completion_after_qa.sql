-- Keep the existing queue RPC contract, but make its successful result truthful:
-- the workflow now calls finish_fam_agent_coder_task only after independent QA.
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
      v_summary := 'Локальная модель подготовила исправление, прошедшее независимую QA-проверку.';
    when 'model_no_patch' then
      v_status := 'completed';
      v_summary := 'Локальная модель завершила анализ и не предложила подтверждённое исправление.';
    when 'model_failed' then
      v_status := 'failed';
      v_summary := 'Локальная модель или независимая QA-проверка завершилась с ошибкой.';
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
  if v_updated is null then return false; end if;
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  values (v_updated,v_status,p_worker_id,v_summary);
  return true;
end;
$function$;
