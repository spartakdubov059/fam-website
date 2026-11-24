-- Disposable PostgreSQL only. Mirror the service-role RLS bypass in this fixture,
-- not in production; no student tables, network, or credentials.
alter role service_role bypassrls;
alter table private.fam_agent_tasks
  alter column id set default gen_random_uuid(),
  add column title text,
  add column description text;
grant insert on private.fam_agent_tasks to service_role;
truncate private.fam_agent_inspector_signals, private.fam_agent_task_events, private.fam_agent_tasks;
set role service_role;
do $$
declare
  v_id uuid;
  v_claimed uuid;
  v_result jsonb;
  v_health jsonb;
begin
  if has_function_privilege('anon','public.enqueue_fam_agent_inspector_task(text,text,integer)','EXECUTE')
      or has_function_privilege('authenticated','public.enqueue_fam_agent_inspector_task(text,text,integer)','EXECUTE') then
    raise exception 'Untrusted roles can enqueue tasks';
  end if;
  begin
    perform public.enqueue_fam_agent_inspector_task('unrecognized','fixture:invalid:1',1);
    raise exception 'Unexpected acceptance of unrecognized signal';
  exception when raise_exception then
    if sqlerrm <> 'invalid inspector signal' then raise; end if;
  end;
  begin
    perform public.enqueue_fam_agent_inspector_task('qwen_repeated_failure','fixture:invalid:2',1001);
    raise exception 'Unexpected acceptance of out-of-bounds count';
  exception when raise_exception then
    if sqlerrm <> 'invalid inspector signal' then raise; end if;
  end;
  if exists(select 1 from private.fam_agent_inspector_signals) then
    raise exception 'Invalid signal left a row';
  end if;
  v_result := public.enqueue_fam_agent_inspector_task('qwen_repeated_failure','fixture:handoff:1',3);
  if (v_result->>'task_created')::boolean is distinct from true then
    raise exception 'Initial allowed signal did not enqueue';
  end if;
  v_id := (v_result->>'task_id')::uuid;
  v_result := public.enqueue_fam_agent_inspector_task('qwen_repeated_failure','fixture:handoff:1',3);
  if v_result->>'reason' is distinct from 'duplicate_event' then raise exception 'Duplicate event not blocked'; end if;
  v_result := public.enqueue_fam_agent_inspector_task('qwen_repeated_failure','fixture:handoff:2',3);
  if v_result->>'reason' is distinct from 'signal_cooldown' then raise exception 'Duplicate signature not blocked'; end if;
  select c.id into strict v_claimed from public.claim_fam_agent_coder_tasks('fam-agent-qwen-coder-v1',1,7200) c;
  if v_claimed is distinct from v_id then raise exception 'Unexpected claim'; end if;
  if public.start_fam_agent_coder_task(v_id,'fam-agent-qwen-coder-v1',1800) is distinct from true then
    raise exception 'Start transition failed';
  end if;
  if public.advance_fam_agent_coder_task(v_id,'fam-agent-qwen-coder-v1','model_generated') is distinct from true then
    raise exception 'Generation transition failed';
  end if;
  if public.advance_fam_agent_coder_task(v_id,'fam-agent-qwen-coder-v1','qa_passed') is distinct from true then
    raise exception 'QA transition failed';
  end if;
  if public.advance_fam_agent_coder_task(v_id,'fam-agent-qwen-coder-v1','pr_created',123) is distinct from true then
    raise exception 'PR transition failed';
  end if;
  if not exists(select 1 from private.fam_agent_tasks where id=v_id and status='in_progress'
      and claimed_by is null and lease_expires_at is null and attempt_count=1
      and result_summary='PR создан после независимой QA; ожидает решения владельца.') then
    raise exception 'Pending-review task retains execution lease or loses its state';
  end if;
  if public.heartbeat_fam_agent_coder_task(v_id,'fam-agent-qwen-coder-v1',1800) is distinct from false then
    raise exception 'Pending review must not accept execution heartbeats';
  end if;
  if public.advance_fam_agent_coder_task(v_id,'fam-agent-qwen-coder-v1','pr_created',123) is distinct from false then
    raise exception 'Repeated PR completion was accepted';
  end if;
  if exists(select 1 from public.claim_fam_agent_coder_tasks('fam-agent-qwen-coder-v1',1,7200)) then
    raise exception 'Pending review was reclaimed';
  end if;
  v_result := public.enqueue_fam_agent_inspector_task('worker_expired_lease','fixture:handoff:3',1);
  if v_result->>'reason' is distinct from 'coder_task_already_active' then
    raise exception 'Current single-active-task policy was bypassed';
  end if;
  if (select count(*) from private.fam_agent_task_events where task_id=v_id and metadata->>'stage'='pr_created' and metadata->>'pr_number'='123') <> 1 then
    raise exception 'Missing or duplicate PR event link';
  end if;
  if (select count(*) from private.fam_agent_tasks) <> 1 then
    raise exception 'Unexpected extra task';
  end if;
  v_health := public.get_fam_agent_queue_health();
  if (v_health->>'in_progress')::integer is distinct from 1
      or (v_health->>'expired_leases')::integer is distinct from 0 then
    raise exception 'Pending review health counters differ from current contract';
  end if;
end $$;
reset role;
select 'PASS: real enqueue, event dedup, signature cooldown, claim to pending review, no reclaim, existing single-active policy' as result;
