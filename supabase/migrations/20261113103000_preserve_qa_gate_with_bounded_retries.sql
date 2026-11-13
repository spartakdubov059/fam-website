-- Supersede the legacy completion RPC from the bounded-retry migration.
-- Legacy callers may schedule one retry or move a generated patch to review, but
-- only the QA/PR-aware RPC can mark a patch-bearing task completed.
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
  if not found then return false; end if;

  case p_result_code
    when 'model_completed' then
      v_status := 'review';
      v_summary := 'Локальная модель подготовила patch; требуется независимый QA и PR.';
    when 'model_no_patch' then
      v_status := 'completed';
      v_summary := 'Локальная модель завершила анализ и не предложила подтверждённое исправление.';
    when 'model_failed' then
      if v_has_retry then
        v_status := 'queued';
        v_summary := 'Временная ошибка coder/QA/PR; назначена одна повторная попытка.';
      else
        v_status := 'failed';
        v_summary := 'Coder/QA/PR завершились с ошибкой после разрешённых попыток.';
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
      pr_url = null,
      commit_sha = null,
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
  if v_updated is null then return false; end if;

  v_event_type := case when v_status = 'queued' then 'retry_scheduled' else v_status end;
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  values (v_updated,v_event_type,p_worker_id,v_summary);
  return true;
end;
$function$;

create or replace function public.finish_fam_agent_coder_task_with_pr(
  p_task_id uuid,
  p_worker_id text,
  p_result_code text,
  p_pr_url text,
  p_commit_sha text
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
  v_event_type text;
  v_updated uuid;
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
  if not found then return false; end if;

  case p_result_code
    when 'model_completed' then
      if p_pr_url is null or p_commit_sha is null then
        raise exception 'completed coder task requires verified PR metadata';
      end if;
      v_status := 'completed';
      v_summary := 'Локальная модель подготовила исправление, прошедшее независимый QA и обязательные проверки PR.';
    when 'model_review' then
      if p_pr_url is null or p_commit_sha is null then
        raise exception 'review coder task requires PR metadata';
      end if;
      v_status := 'review';
      v_summary := 'Draft PR создан; обязательная проверка не завершилась успешно, требуется ручной просмотр.';
    when 'model_no_patch' then
      if p_pr_url is not null or p_commit_sha is not null then
        raise exception 'no-patch coder task cannot store PR metadata';
      end if;
      v_status := 'completed';
      v_summary := 'Локальная модель завершила анализ и не предложила подтверждённое исправление.';
    when 'model_failed' then
      if p_pr_url is not null or p_commit_sha is not null then
        raise exception 'failed coder task cannot store PR metadata';
      end if;
      if v_has_retry then
        v_status := 'queued';
        v_summary := 'Временная ошибка coder/QA/PR; назначена одна повторная попытка.';
      else
        v_status := 'failed';
        v_summary := 'Coder/QA/PR завершились с ошибкой после разрешённых попыток.';
      end if;
    when 'model_blocked' then
      if p_pr_url is not null or p_commit_sha is not null then
        raise exception 'blocked coder task cannot store PR metadata';
      end if;
      v_status := 'blocked';
      v_summary := 'Задание остановлено защитными ограничениями.';
    else
      raise exception 'invalid coder result code';
  end case;

  if p_pr_url is not null and p_pr_url !~ '^https://github\.com/spartakdubov059/fam-website/pull/[1-9][0-9]*$' then
    raise exception 'invalid coder PR URL';
  end if;
  if p_commit_sha is not null and p_commit_sha !~ '^[0-9a-fA-F]{40}$' then
    raise exception 'invalid coder commit SHA';
  end if;

  update private.fam_agent_tasks as t
  set status = v_status,
      result_summary = v_summary,
      pr_url = p_pr_url,
      commit_sha = p_commit_sha,
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
  if v_updated is null then return false; end if;

  v_event_type := case when v_status = 'queued' then 'retry_scheduled' else v_status end;
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  values (v_updated,v_event_type,p_worker_id,v_summary);
  return true;
end;
$function$;

revoke all on function public.finish_fam_agent_coder_task(uuid,text,text) from public,anon,authenticated;
grant execute on function public.finish_fam_agent_coder_task(uuid,text,text) to service_role;
revoke all on function public.finish_fam_agent_coder_task_with_pr(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.finish_fam_agent_coder_task_with_pr(uuid,text,text,text,text) to service_role;
