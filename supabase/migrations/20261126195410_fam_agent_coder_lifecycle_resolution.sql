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
  v_approved_head_sha text;
  v_merge_commit_sha text;
  v_lifecycle_state text;
  v_summary text;
  v_status text;
  v_event text;
  v_finished boolean := false;
begin
  if p_worker_id is distinct from 'fam-agent-integrator-v1' then
    raise exception 'invalid integrator worker';
  end if;
  if p_stage is null or p_stage not in (
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

  if p_stage in ('owner_approved','pr_closed_unmerged') and p_merge_commit_sha is not null then
    raise exception 'unexpected merge commit sha';
  end if;

  select * into v_task
  from private.fam_agent_tasks
  where id = p_task_id
    and agent_key = 'technical'
    and task_type = 'coder_patch_request'
    and approval_required = false
    and source in ('system','scheduled_audit')
  for update;
  if not found or v_task.claimed_by is not null then
    return false;
  end if;
  if v_task.status not in ('in_progress','completed') then
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
  v_approved_head_sha := v_task.payload->>'approved_head_sha';
  v_merge_commit_sha := v_task.payload->>'merge_commit_sha';
  v_lifecycle_state := coalesce(v_task.payload->>'lifecycle_state','pending_review');

  -- Terminal replay is acknowledged only for the exact same evidence.
  if v_task.status = 'completed' then
    if p_stage = 'postmerge_verified'
      and v_lifecycle_state = 'completed'
      and v_head_sha = p_head_sha
      and v_merge_commit_sha = p_merge_commit_sha
      and exists (
        select 1 from private.fam_agent_task_events
        where task_id = p_task_id and metadata->>'stage' = 'postmerge_verified'
          and metadata->>'pr_number' = p_pr_number::text
          and metadata->>'head_sha' = p_head_sha
          and metadata->>'merge_commit_sha' = p_merge_commit_sha
      ) then
      return true;
    end if;
    if p_stage = 'owner_approved'
      and v_lifecycle_state = 'completed'
      and v_head_sha = p_head_sha
      and v_approved_head_sha = p_head_sha
    then
      return true;
    end if;
    if p_stage = 'merged'
      and v_lifecycle_state = 'completed'
      and v_head_sha = p_head_sha
      and v_merge_commit_sha = p_merge_commit_sha
      and exists (
        select 1 from private.fam_agent_task_events
        where task_id = p_task_id and metadata->>'stage' = 'merged'
          and metadata->>'pr_number' = p_pr_number::text
          and metadata->>'head_sha' = p_head_sha
          and metadata->>'merge_commit_sha' = p_merge_commit_sha
      )
    then
      return true;
    end if;
    return false;
  end if;

  if p_stage = 'owner_approved' then
    if exists (
      select 1 from private.fam_agent_task_events
      where task_id = p_task_id and metadata->>'stage' = 'owner_approved'
        and metadata->>'pr_number' = p_pr_number::text
        and metadata->>'head_sha' = p_head_sha
        and v_lifecycle_state in ('approved_waiting_merge','merged_pending_postmerge','merged_postmerge_failed','completed')
        and v_approved_head_sha = p_head_sha
    ) then
      return true;
    end if;
    if v_lifecycle_state in ('merged_pending_postmerge','merged_postmerge_failed','completed') then
      return false;
    end if;
    -- Before merge, a changed head SHA replaces the previous approval.
    -- After close/reopen, the same head can be approved again.
    if v_lifecycle_state not in ('pending_review','closed_unmerged','approved_waiting_merge') then
      return false;
    end if;
    if v_lifecycle_state = 'approved_waiting_merge'
      and v_head_sha is distinct from p_head_sha
    then
      -- A new revision invalidates prior merge evidence and starts a fresh review.
      v_lifecycle_state := 'pending_review';
      v_merge_commit_sha := null;
    elsif v_lifecycle_state = 'closed_unmerged'
      and v_head_sha is distinct from p_head_sha
    then
      v_lifecycle_state := 'pending_review';
      v_merge_commit_sha := null;
    end if;
    v_summary := 'Подтверждено одобрение владельца точной ревизии PR.';
    v_status := 'in_progress';
    v_event := 'progress';
    v_lifecycle_state := 'approved_waiting_merge';
    v_head_sha := p_head_sha;
    v_approved_head_sha := p_head_sha;
    v_merge_commit_sha := null;
  elsif p_stage = 'merged' then
    if exists (
      select 1 from private.fam_agent_task_events
      where task_id = p_task_id and metadata->>'stage' = 'merged'
        and metadata->>'pr_number' = p_pr_number::text
        and metadata->>'head_sha' = p_head_sha
        and metadata->>'merge_commit_sha' = p_merge_commit_sha
        and v_lifecycle_state in ('merged_pending_postmerge','merged_postmerge_failed','completed')
        and v_head_sha = p_head_sha
        and v_merge_commit_sha = p_merge_commit_sha
    ) then
      return true;
    end if;
    if v_lifecycle_state not in ('approved_waiting_merge') then
      return false;
    end if;
    if v_approved_head_sha is distinct from p_head_sha
      or v_head_sha is distinct from p_head_sha
    then
      return false;
    end if;
    if p_merge_commit_sha is null or p_merge_commit_sha !~ '^[0-9a-fA-F]{40}$'
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
    v_lifecycle_state := 'merged_pending_postmerge';
    v_merge_commit_sha := p_merge_commit_sha;
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
    if v_lifecycle_state not in ('merged_pending_postmerge','merged_postmerge_failed') then
      return false;
    end if;
    if p_merge_commit_sha is null or p_merge_commit_sha !~ '^[0-9a-fA-F]{40}$'
      or v_head_sha is distinct from p_head_sha
      or v_merge_commit_sha is distinct from p_merge_commit_sha
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
    v_lifecycle_state := 'completed';
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
    if v_lifecycle_state not in ('merged_pending_postmerge','merged_postmerge_failed') then
      return false;
    end if;
    if v_lifecycle_state = 'merged_postmerge_failed'
      and v_merge_commit_sha = p_merge_commit_sha
      and v_head_sha = p_head_sha
    then
      return true;
    end if;
    if p_merge_commit_sha is null or p_merge_commit_sha !~ '^[0-9a-fA-F]{40}$'
      or v_head_sha is distinct from p_head_sha
      or v_merge_commit_sha is distinct from p_merge_commit_sha
    then
      return false;
    end if;
    v_summary := 'Merge-коммит не прошёл проверку CI после объединения.';
    v_status := 'in_progress';
    v_event := 'progress';
    v_lifecycle_state := 'merged_postmerge_failed';
  else
    if exists (
      select 1 from private.fam_agent_task_events
      where task_id = p_task_id and metadata->>'stage' = 'pr_closed_unmerged'
        and metadata->>'pr_number' = p_pr_number::text
        and metadata->>'head_sha' = p_head_sha
        and v_lifecycle_state = 'closed_unmerged'
    ) then
      return true;
    end if;
    if v_lifecycle_state in ('merged_pending_postmerge','merged_postmerge_failed','completed') then
      return false;
    end if;
    v_summary := 'PR закрыт без merge; требуется повторно проверить reopened PR.';
    v_status := 'in_progress';
    v_event := 'progress';
    v_lifecycle_state := 'closed_unmerged';
    v_head_sha := p_head_sha;
    v_approved_head_sha := null;
    v_merge_commit_sha := null;
  end if;

  update private.fam_agent_tasks as t
  set status = v_status,
      result_summary = v_summary,
      payload = t.payload
        || pg_catalog.jsonb_build_object(
          'pr_number', p_pr_number,
          'pr_head_sha', v_head_sha,
          'approved_head_sha', v_approved_head_sha,
          'merge_commit_sha', v_merge_commit_sha,
          'lifecycle_state', v_lifecycle_state
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