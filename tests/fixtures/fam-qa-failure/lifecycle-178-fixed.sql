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
