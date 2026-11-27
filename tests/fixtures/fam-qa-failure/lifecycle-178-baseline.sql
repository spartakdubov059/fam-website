-- Persist verified GitHub lifecycle evidence for the FAM coder queue.
-- Owner approval and merge stages require exact evidence supplied by the
-- read-only reconciliation job; this RPC never approves or merges itself.

create or replace function public.resolve_fam_agent_coder_lifecycle(
  p_task_id uuid,
  p_worker_id text,
  p_stage text,
  p_pr_number integer default null,
  p_head_sha text default null,
  p_merge_commit_sha text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_task private.fam_agent_tasks%rowtype;
  v_pr_number integer;
  v_head_sha text;
  v_summary text;
  v_status text;
  v_event text;
  v_finished boolean := false;
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then
    raise exception 'invalid coder worker';
  end if;
  if p_stage not in (
    'owner_approved','merged','postmerge_verified','postmerge_failed','pr_closed_unmerged'
  ) then
    raise exception 'invalid coder resolution stage';
  end if;
  if p_pr_number is null or p_pr_number < 1 or p_pr_number > 99999999 then
    raise exception 'invalid pull request number';
  end if;
  if p_head_sha is null or p_head_sha !~ '^[0-9a-fA-F]{40}$' then
    raise exception 'invalid pull request head sha';
  end if;

  select * into v_task
  from private.fam_agent_tasks
  where id = p_task_id
    and agent_key = 'technical'
    and task_type = 'coder_patch_request'
    and approval_required = false
    and source in ('system','scheduled_audit')
  for update;
  if not found or v_task.status <> 'in_progress' or v_task.claimed_by is not null then
    return false;
  end if;

  v_pr_number := coalesce(
    (v_task.payload->>'pr_number')::integer,
    (
      select (metadata->>'pr_number')::integer
      from private.fam_agent_task_events
      where task_id = p_task_id
        and event_type = 'progress'
        and metadata->>'stage' = 'pr_created'
      order by created_at desc
      limit 1
    )
  );
  if v_pr_number is distinct from p_pr_number then
    return false;
  end if;
  v_head_sha := v_task.payload->>'pr_head_sha';

  if p_stage = 'owner_approved' then
    if exists (
      select 1 from private.fam_agent_task_events
      where task_id = p_task_id and metadata->>'stage' = 'owner_approved'
        and metadata->>'pr_number' = p_pr_number::text
        and metadata->>'head_sha' = p_head_sha
    ) then
      return true;
    end if;
    if v_task.result_summary not in (
      'PR создан после независимой QA; ожидает решения владельца.',
      'PR закрыт без merge; требуется повторно проверить reopened PR.'
    ) then
      return false;
    end if;
    v_summary := 'Подтверждено одобрение владельца точной ревизии PR.';
    v_status := 'in_progress';
    v_event := 'progress';
  elsif p_stage = 'merged' then
    if exists (
      select 1 from private.fam_agent_task_events
      where task_id = p_task_id and metadata->>'stage' = 'merged'
        and metadata->>'pr_number' = p_pr_number::text
        and metadata->>'head_sha' = p_head_sha
        and metadata->>'merge_commit_sha' = p_merge_commit_sha
    ) then
      return true;
    end if;
    if p_merge_commit_sha is null or p_merge_commit_sha !~ '^[0-9a-fA-F]{40}$'
      or v_head_sha is distinct from p_head_sha
      or v_task.result_summary <> 'Подтверждено одобрение владельца точной ревизии PR.'
      or not exists (
        select 1 from private.fam_agent_task_events
        where task_id = p_task_id and event_type = 'progress'
          and metadata->>'stage' = 'owner_approved'
          and metadata->>'pr_number' = p_pr_number::text
          and metadata->>'head_sha' = p_head_sha
      )
    then
      return false;
    end if;
    v_summary := 'PR объединён; ожидается проверка точного merge-коммита.';
    v_status := 'in_progress';
    v_event := 'progress';
  elsif p_stage = 'postmerge_verified' then
    if exists (
      select 1 from private.fam_agent_task_events
      where task_id = p_task_id and metadata->>'stage' = 'postmerge_verified'
        and metadata->>'pr_number' = p_pr_number::text
        and metadata->>'head_sha' = p_head_sha
        and metadata->>'merge_commit_sha' = p_merge_commit_sha
    ) then
      return true;
    end if;
    if p_merge_commit_sha is null or p_merge_commit_sha !~ '^[0-9a-fA-F]{40}$'
      or v_head_sha is distinct from p_head_sha
      or v_task.result_summary not in (
        'PR объединён; ожидается проверка точного merge-коммита.',
        'Merge-коммит не прошёл проверку CI после объединения.'
      )
      or not exists (
        select 1 from private.fam_agent_task_events
        where task_id = p_task_id and event_type = 'progress'
          and metadata->>'stage' = 'merged'
          and metadata->>'merge_commit_sha' = p_merge_commit_sha
      )
    then
      return false;
    end if;
    v_summary := 'Одобрение владельца, merge и CI объединённого коммита подтверждены.';
    v_status := 'completed';
    v_event := 'completed';
    v_finished := true;
  elsif p_stage = 'postmerge_failed' then
    if exists (
      select 1 from private.fam_agent_task_events
      where task_id = p_task_id and metadata->>'stage' = 'postmerge_failed'
        and metadata->>'pr_number' = p_pr_number::text
        and metadata->>'head_sha' = p_head_sha
        and metadata->>'merge_commit_sha' = p_merge_commit_sha
    ) then
      return true;
    end if;
    if p_merge_commit_sha is null or p_merge_commit_sha !~ '^[0-9a-fA-F]{40}$'
      or v_head_sha is distinct from p_head_sha
      or v_task.result_summary <> 'PR объединён; ожидается проверка точного merge-коммита.'
    then
      return false;
    end if;
    v_summary := 'Merge-коммит не прошёл проверку CI после объединения.';
    v_status := 'in_progress';
    v_event := 'progress';
  else
    if exists (
      select 1 from private.fam_agent_task_events
      where task_id = p_task_id and metadata->>'stage' = 'pr_closed_unmerged'
        and metadata->>'pr_number' = p_pr_number::text
        and metadata->>'head_sha' = p_head_sha
    ) then
      return true;
    end if;
    if v_task.result_summary = 'Одобрение владельца, merge и CI объединённого коммита подтверждены.' then
      return false;
    end if;
    v_summary := 'PR закрыт без merge; требуется повторно проверить reopened PR.';
    v_status := 'in_progress';
    v_event := 'progress';
  end if;

  update private.fam_agent_tasks as t
  set status = v_status,
      result_summary = v_summary,
      payload = t.payload
        || pg_catalog.jsonb_build_object(
          'pr_number', p_pr_number,
          'pr_head_sha', p_head_sha,
          'merge_commit_sha', coalesce(p_merge_commit_sha, t.payload->>'merge_commit_sha')
        ),
      lease_expires_at = null,
      finished_at = case when v_finished then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where t.id = p_task_id;

  insert into private.fam_agent_task_events(task_id,event_type,actor,summary,metadata)
  values (
    p_task_id,
    v_event,
    'fam-agent-integrator-v1',
    v_summary,
    pg_catalog.jsonb_build_object(
      'stage', p_stage,
      'pr_number', p_pr_number,
      'head_sha', p_head_sha,
      'merge_commit_sha', p_merge_commit_sha
    )
  );
  return true;
end;
$function$;

revoke all on function public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)
  from public,anon,authenticated;
grant execute on function public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)
  to service_role;
