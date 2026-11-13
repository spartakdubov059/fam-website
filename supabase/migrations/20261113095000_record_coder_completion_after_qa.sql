alter table private.fam_agent_tasks
  add column pr_url text,
  add column commit_sha text,
  add constraint fam_agent_tasks_pr_metadata_pair_check
    check ((pr_url is null) = (commit_sha is null)),
  add constraint fam_agent_tasks_pr_url_check
    check (pr_url is null or pr_url ~ '^https://github\\.com/spartakdubov059/fam-website/pull/[1-9][0-9]*$'),
  add constraint fam_agent_tasks_commit_sha_check
    check (commit_sha is null or commit_sha ~ '^[0-9a-fA-F]{40}$');

-- Persist PR identity only after independent QA and required PR checks succeed.
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
  v_updated uuid;
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then
    raise exception 'invalid coder worker';
  end if;

  case p_result_code
    when 'model_completed' then
      if p_pr_url is null or p_commit_sha is null then
        raise exception 'completed coder task requires verified PR metadata';
      end if;
      v_status := 'completed';
      v_summary := 'Локальная модель подготовила исправление, прошедшее независимый QA и обязательные проверки PR.';
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
      v_status := 'failed';
      v_summary := 'Локальная модель, независимая QA-проверка или создание PR завершились с ошибкой.';
    when 'model_blocked' then
      if p_pr_url is not null or p_commit_sha is not null then
        raise exception 'blocked coder task cannot store PR metadata';
      end if;
      v_status := 'blocked';
      v_summary := 'Задание остановлено защитными ограничениями.';
    else
      raise exception 'invalid coder result code';
  end case;

  if p_pr_url is not null and p_pr_url !~ '^https://github\\.com/spartakdubov059/fam-website/pull/[1-9][0-9]*$' then
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

revoke all on function public.finish_fam_agent_coder_task_with_pr(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.finish_fam_agent_coder_task_with_pr(uuid,text,text,text,text) to service_role;
