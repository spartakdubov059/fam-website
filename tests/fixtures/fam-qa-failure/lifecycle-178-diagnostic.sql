-- Synthetic diagnostic, NOT acceptance of the PR #178 migration.
-- Exact candidate loaded from 4b0de032c08073e041b10fd89beab664d7552b80.
-- Only disposable PostgreSQL. Never execute in production.
truncate private.fam_agent_inspector_signals, private.fam_agent_task_events, private.fam_agent_tasks;
alter table private.fam_agent_task_events add column created_at timestamptz not null default now();
set role service_role;
do $$
declare
  task_a uuid := gen_random_uuid();
  task_b uuid := gen_random_uuid();
  task_c uuid := gen_random_uuid();
  worker text := 'fam-agent-qwen-coder-v1';
  head_a text := repeat('a',40);
  head_b text := repeat('b',40);
  merge_sha text := repeat('c',40);
  other_merge text := repeat('d',40);
  task_id uuid;
begin
  if has_function_privilege('anon','public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)','EXECUTE')
      or has_function_privilege('authenticated','public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)','EXECUTE') then
    raise exception 'Unexpected public access';
  end if;
  foreach task_id in array array[task_a,task_b,task_c] loop
    insert into private.fam_agent_tasks(id,agent_key,task_type,approval_required,source,status,
      result_summary,claimed_by,claimed_at,lease_expires_at,attempt_count)
    values(task_id,'technical','coder_patch_request',false,'system','in_progress',
      'Независимая QA прошла; PR ещё не создан.',worker,now(),now()+interval '1 hour',1);
    if public.advance_fam_agent_coder_task(task_id,worker,'pr_created',123) is distinct from true then
      raise exception 'Fixture PR transition failed';
    end if;
  end loop;
  if public.resolve_fam_agent_coder_lifecycle(task_a,worker,'owner_approved',124,head_a) is distinct from false then
    raise exception 'Wrong PR not rejected';
  end if;
  if public.resolve_fam_agent_coder_lifecycle(task_a,worker,'owner_approved',123,head_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_a,worker,'merged',123,head_a,merge_sha) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_a,worker,'postmerge_verified',123,head_a,merge_sha) is distinct from true then
    raise exception 'Original happy path failed';
  end if;
  if not exists(select 1 from private.fam_agent_tasks t where t.id=task_a and t.status='completed' and t.finished_at is not null) then
    raise exception 'Completion missing';
  end if;
  if public.resolve_fam_agent_coder_lifecycle(task_a,worker,'postmerge_verified',123,head_a,merge_sha) is distinct from false then
    raise exception 'Observed terminal replay behavior changed; update diagnostic';
  end if;
  raise notice 'KNOWN DEFECT REPRODUCED: exact completed event replay returns false rather than idempotent acknowledgment';

  if public.resolve_fam_agent_coder_lifecycle(task_b,worker,'owner_approved',123,head_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_b,worker,'pr_closed_unmerged',123,head_a) is distinct from true
    or public.resolve_fam_agent_coder_lifecycle(task_b,worker,'owner_approved',123,head_a) is distinct from true then
    raise exception 'Reopen setup failed';
  end if;
  if public.resolve_fam_agent_coder_lifecycle(task_b,worker,'merged',123,head_a,merge_sha) is distinct from false then
    raise exception 'Observed reopen behavior changed; update diagnostic';
  end if;
  raise notice 'KNOWN DEFECT REPRODUCED: same-head reopen reuses historical approval but does not restore current state';

  if public.resolve_fam_agent_coder_lifecycle(task_c,worker,'owner_approved',123,head_a) is distinct from true then
    raise exception 'Approval setup failed';
  end if;
  if public.resolve_fam_agent_coder_lifecycle(task_c,worker,'owner_approved',123,head_b) is distinct from false then
    raise exception 'Observed revised-head behavior changed; update diagnostic';
  end if;
  raise notice 'KNOWN DEFECT REPRODUCED: verified approval for changed head cannot replace stale approval';
  if public.resolve_fam_agent_coder_lifecycle(task_c,worker,'merged',123,head_a,merge_sha) is distinct from true then
    raise exception 'Merge setup failed';
  end if;
  if public.resolve_fam_agent_coder_lifecycle(task_c,worker,'postmerge_failed',123,head_a,other_merge) is distinct from true then
    raise exception 'Observed wrong-merge behavior changed; update diagnostic';
  end if;
  raise notice 'KNOWN DEFECT REPRODUCED: failed-CI event accepts a different merge SHA';
  if public.resolve_fam_agent_coder_lifecycle(task_c,worker,'pr_closed_unmerged',123,head_a) is distinct from true then
    raise exception 'Observed close-after-merge behavior changed; update diagnostic';
  end if;
  raise notice 'KNOWN DEFECT REPRODUCED: closed-unmerged event overwrites a known merged state';
end $$;
reset role;
select 'DIAGNOSTIC PASS: reproduced five lifecycle defects in original PR #178 candidate; NOT release approval' as result;
