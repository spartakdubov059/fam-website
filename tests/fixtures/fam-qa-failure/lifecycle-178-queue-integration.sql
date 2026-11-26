-- Disposable PostgreSQL only: connect the real queue RPCs to the fixed #178 resolver.
-- No GitHub approvals, real model invocations, production rows or credentials.
truncate private.fam_agent_inspector_signals, private.fam_agent_task_events, private.fam_agent_tasks;
set role service_role;
do $$
declare
  worker text := 'fam-agent-qwen-coder-v1';
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
  if public.resolve_fam_agent_coder_lifecycle(first_id,worker,'owner_approved',124,head_sha) is distinct from false then raise exception 'Incorrect PR accepted'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,worker,'owner_approved',123,head_sha) is distinct from true then raise exception 'Approval persistence failed'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,worker,'merged',123,head_sha,merge_sha) is distinct from true then raise exception 'Merge persistence failed'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,worker,'postmerge_failed',123,head_sha,merge_sha) is distinct from true then raise exception 'Failed CI persistence failed'; end if;
  result := public.enqueue_fam_agent_inspector_task('worker_expired_lease','fixture:complete:2',1);
  if result->>'reason' is distinct from 'coder_task_already_active' then raise exception 'Queue released before verified postmerge CI'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,worker,'postmerge_verified',123,head_sha,merge_sha) is distinct from true then raise exception 'Verified CI persistence failed'; end if;
  if public.resolve_fam_agent_coder_lifecycle(first_id,worker,'postmerge_verified',123,head_sha,merge_sha) is distinct from true then raise exception 'Exact replay rejected'; end if;
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
