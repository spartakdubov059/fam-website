-- Isolated acceptance fixture for the fixed PR #178 lifecycle resolver.
-- This file creates only disposable queue shapes; never run against production.

create schema if not exists private;
create table if not exists private.fam_agent_tasks (
  id uuid primary key,
  agent_key text not null,
  task_type text not null,
  approval_required boolean not null,
  source text not null,
  status text not null,
  result_summary text,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  finished_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now()
);
create table if not exists private.fam_agent_task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references private.fam_agent_tasks(id),
  event_type text not null,
  actor text not null,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now()
);
truncate private.fam_agent_inspector_signals,
  private.fam_agent_task_events,
  private.fam_agent_tasks
cascade;

do $$
declare
  worker text := 'fam-agent-integrator-v1';
  qwen_worker text := 'fam-agent-qwen-coder-v1';
  task_a uuid := gen_random_uuid();
  task_b uuid := gen_random_uuid();
  task_c uuid := gen_random_uuid();
  task_d uuid := gen_random_uuid();
  head_a text := repeat('a',40);
  head_b text := repeat('b',40);
  merge_a text := repeat('c',40);
  merge_wrong text := repeat('d',40);
  task_id uuid;
begin
  begin
    perform public.resolve_fam_agent_coder_lifecycle(
      gen_random_uuid(),qwen_worker,'owner_approved',123,repeat('a',40)
    );
    raise exception 'Qwen worker unexpectedly resolved lifecycle';
  exception when others then
    if sqlerrm = 'Qwen worker unexpectedly resolved lifecycle' then raise; end if;
    if sqlerrm <> 'invalid integrator worker' then raise; end if;
  end;

  foreach task_id in array array[task_a,task_b,task_c,task_d] loop
    insert into private.fam_agent_tasks(
      id,agent_key,task_type,approval_required,source,status,result_summary,
      claimed_by,lease_expires_at,attempt_count,payload
    ) values(
      task_id,'technical','coder_patch_request',false,'system','in_progress',
      'PR создан после независимой QA; ожидает решения владельца.',
      null,null,1,pg_catalog.jsonb_build_object('pr_number',123,'lifecycle_state','pending_review')
    );
    insert into private.fam_agent_task_events(task_id,event_type,actor,summary,metadata)
    values(task_id,'progress',worker,'PR создан','{"stage":"pr_created","pr_number":123}');
  end loop;

  -- Direct RPC validation must reject NULL and inconsistent evidence without changing state.
  begin
    perform public.resolve_fam_agent_coder_lifecycle(task_a,worker,null,123,head_a);
    raise exception 'NULL stage accepted';
  exception when others then
    if sqlerrm <> 'invalid coder resolution stage' then raise; end if;
  end;
  begin
    perform public.resolve_fam_agent_coder_lifecycle(task_a,worker,'owner_approved',123,head_a,merge_a);
    raise exception 'Unexpected merge evidence accepted';
  exception when others then
    if sqlerrm <> 'unexpected merge commit sha' then raise; end if;
  end;
  if not exists(select 1 from private.fam_agent_tasks where id=task_a
    and status='in_progress' and payload->>'lifecycle_state'='pending_review')
    or (select count(*) from private.fam_agent_task_events as e where e.task_id=task_a) <> 1
  then raise exception 'Invalid lifecycle input changed state or audit'; end if;

  -- Completed replay is idempotent only for the exact terminal evidence.
  if public.resolve_fam_agent_coder_lifecycle(task_a,worker,'owner_approved',123,head_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_a,worker,'merged',123,head_a,merge_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_a,worker,'postmerge_verified',123,head_a,merge_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_a,worker,'postmerge_verified',123,head_a,merge_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_a,worker,'postmerge_verified',123,head_a,merge_wrong) is distinct from false
    or public.resolve_fam_agent_coder_lifecycle(task_a,worker,'pr_closed_unmerged',123,head_a) is distinct from false
  then raise exception 'Terminal replay or post-merge transition failed'; end if;
  if not exists(select 1 from private.fam_agent_tasks where id=task_a and status='completed' and finished_at is not null) then
    raise exception 'Verified postmerge task did not complete';
  end if;

  -- Close/reopen restores the same head for a fresh approval.
  if public.resolve_fam_agent_coder_lifecycle(task_b,worker,'owner_approved',123,head_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_b,worker,'pr_closed_unmerged',123,head_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_b,worker,'owner_approved',123,head_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_b,worker,'merged',123,head_a,merge_a) is distinct from true
  then raise exception 'Reopen lifecycle failed'; end if;

  -- A changed head creates a fresh approval and cannot merge or close stale evidence.
  if public.resolve_fam_agent_coder_lifecycle(task_c,worker,'owner_approved',123,head_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_c,worker,'owner_approved',123,head_b) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_c,worker,'merged',123,head_a,merge_a) is distinct from false
    or public.resolve_fam_agent_coder_lifecycle(task_c,worker,'merged',123,head_b,merge_a) is distinct from true
  then raise exception 'New PR revision approval or exact-head merge failed'; end if;

  -- Failed-CI and exact merge SHA transitions remain recoverable.
  if public.resolve_fam_agent_coder_lifecycle(task_d,worker,'owner_approved',123,head_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_d,worker,'merged',123,head_a,merge_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_d,worker,'postmerge_failed',123,head_a,merge_wrong) is distinct from false
    or public.resolve_fam_agent_coder_lifecycle(task_d,worker,'postmerge_failed',123,head_a,merge_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_d,worker,'postmerge_verified',123,head_a,merge_a) is distinct from true
  then raise exception 'Exact merge SHA or failed-CI recovery failed'; end if;

  if has_function_privilege('anon','public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)','EXECUTE')
  then raise exception 'Resolver is public'; end if;
end $$;

select 'PASS: fixed lifecycle replay, reopen, revised-head approval, exact merge SHA, and postmerge transitions' as result;

-- Disposable PostgreSQL only: connect the real queue RPCs to the fixed #178 resolver.
-- No GitHub approvals, real model invocations, production rows or credentials.
truncate private.fam_agent_inspector_signals, private.fam_agent_task_events, private.fam_agent_tasks;
set role service_role;
do $$
declare
  worker text := 'fam-agent-qwen-coder-v1';
  integrator text := 'fam-agent-integrator-v1';
  first_id uuid;
  next_id uuid;
  claimed uuid;
  head_sha text := repeat('a',40);
  merge_sha text := repeat('b',40);
  result jsonb;
begin
  result := public.enqueue_fam_agent_inspector_task('qwen_repeated_failure','fixture:complete:1',3);
  if (result->>'task_created')::boolean is distinct from true then raise exception 'Enqueue failed'; end if;
  first_id := (result->>'task_id')::uuid;
  select c.id into strict claimed from public.claim_fam_agent_coder_tasks(worker,1,7200) c;
  if claimed is distinct from first_id then raise exception 'Claim mismatch'; end if;
  if public.start_fam_agent_coder_task(first_id,worker,1800) is distinct from true then raise exception 'Start failed'; end if;
  if public.advance_fam_agent_coder_task(first_id,worker,'model_generated') is distinct from true then raise exception 'Generation failed'; end if;
  if public.advance_fam_agent_coder_task(first_id,worker,'qa_passed') is distinct from true then raise exception 'QA failed'; end if;
  if public.advance_fam_agent_coder_task(first_id,worker,'pr_created',123) is distinct from true then raise exception 'PR link failed'; end if;
  -- pr_created must use the real event fallback, not a fabricated payload PR number.
  if not exists(select 1 from private.fam_agent_task_events e
    where e.task_id=first_id and e.metadata->>'stage'='pr_created' and e.metadata->>'pr_number'='123')
    or exists(select 1 from private.fam_agent_tasks t where t.id=first_id and t.payload ? 'pr_number')
  then raise exception 'Real queue PR event linkage not established'; end if;
  result := public.enqueue_fam_agent_inspector_task('worker_expired_lease','fixture:complete:pending',1);
  if result->>'reason' is distinct from 'coder_task_already_active' then raise exception 'Queue released before owner approval'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,integrator,'owner_approved',124,head_sha) is distinct from false then raise exception 'Incorrect PR accepted'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,integrator,'owner_approved',123,head_sha) is distinct from true then raise exception 'Approval persistence failed'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,integrator,'merged',123,head_sha,merge_sha) is distinct from true then raise exception 'Merge persistence failed'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,integrator,'postmerge_failed',123,head_sha,merge_sha) is distinct from true then raise exception 'Failed CI persistence failed'; end if;
  result := public.enqueue_fam_agent_inspector_task('worker_expired_lease','fixture:complete:2',1);
  if result->>'reason' is distinct from 'coder_task_already_active' then raise exception 'Queue released before verified postmerge CI'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,integrator,'postmerge_verified',123,head_sha,merge_sha) is distinct from true then raise exception 'Verified CI persistence failed'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,integrator,'postmerge_verified',123,head_sha,merge_sha) is distinct from true then raise exception 'Exact replay rejected'; end if;
  if (select count(*) from private.fam_agent_task_events e where e.task_id=first_id and e.metadata->>'stage'='postmerge_verified') <> 1 then raise exception 'Duplicate completion events'; end if;
  if not exists(select 1 from private.fam_agent_tasks t where t.id=first_id and t.status='completed' and t.claimed_by is null and t.lease_expires_at is null and t.finished_at is not null) then raise exception 'Task not terminal'; end if;
  result := public.get_fam_agent_queue_health();
  if (result->>'in_progress')::integer is distinct from 0 then raise exception 'Queue health retained completed task'; end if;
  result := public.enqueue_fam_agent_inspector_task('worker_expired_lease','fixture:complete:3',1);
  if (result->>'task_created')::boolean is distinct from true then raise exception 'Next task not admitted'; end if;
  next_id := (result->>'task_id')::uuid;
  select c.id into strict claimed from public.claim_fam_agent_coder_tasks(worker,1,7200) c;
  if claimed is distinct from next_id or claimed=first_id then raise exception 'Wrong next task'; end if;
  if public.finish_fam_agent_coder_task(next_id,worker,'model_no_patch') is distinct from true then raise exception 'Next task finalization failed'; end if;
end $$;
reset role;
select 'PASS: real queue RPC transitions to fixed resolver, failed CI retains queue, verified completion releases queue, no duplicate event, next task claimed' as result;
