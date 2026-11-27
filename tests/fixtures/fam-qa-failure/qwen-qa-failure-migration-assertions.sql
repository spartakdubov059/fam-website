-- Exercise the real proposed function in local PostgreSQL, not a JS mock.
do $$
begin
  if to_regprocedure('public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)') is null then
    raise exception 'Earlier lifecycle resolver migration was not retained';
  end if;
  if has_function_privilege('anon','public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)','execute')
      or has_function_privilege('authenticated','public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)','execute')
      or not has_function_privilege('service_role','public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)','execute') then
    raise exception 'Earlier lifecycle resolver grants changed';
  end if;
  if has_function_privilege('anon','public.advance_fam_agent_coder_task(uuid,text,text,integer)','execute')
    or has_function_privilege('authenticated','public.advance_fam_agent_coder_task(uuid,text,text,integer)','execute')
    or not has_function_privilege('service_role','public.advance_fam_agent_coder_task(uuid,text,text,integer)','execute') then
    raise exception 'Unexpected function access';
  end if;
end $$;
set role service_role;
do $$
declare
  task uuid;
  i integer;
begin
  -- QA may fail directly after generation or during independent PR CI.
  for i in 1..2 loop
    task := ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','qa_failed') is distinct from true then
      raise exception 'Expected QA failure transition for fixture %',i;
    end if;
    if not exists(select 1 from private.fam_agent_tasks where id=task and status='blocked'
        and claimed_by is null and claimed_at is null and lease_expires_at is null) then
      raise exception 'Blocked task retained claim or lease';
    end if;
    if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','qa_failed') is distinct from false then
      raise exception 'Repeated failure accepted';
    end if;
    if (select count(*) from private.fam_agent_task_events where task_id=task and event_type='blocked'
        and metadata->>'stage'='qa_failed') <> 1 then
      raise exception 'Missing or duplicate failure event';
    end if;
    if exists(select 1 from private.fam_agent_task_events where task_id=task and metadata->>'stage'='qa_passed') then
      raise exception 'False QA success recorded';
    end if;
  end loop;
  -- An unavailable runner blocks separately from a rejected patch.
  task := '00000000-0000-4000-8000-000000000003';
  if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','model_generated') is distinct from true then
    raise exception 'Expected model-generated transition before QA';
  end if;
  if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','qa_unavailable') is distinct from true then
    raise exception 'Expected QA-unavailable transition';
  end if;
  if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','qa_unavailable') is distinct from false then
    raise exception 'Repeated QA-unavailable transition accepted';
  end if;
  if not exists(select 1 from private.fam_agent_tasks where id=task and status='blocked'
      and result_summary='Независимая QA не состоялась из-за сбоя среды; качество изменения не установлено.'
      and claimed_by is null and claimed_at is null and lease_expires_at is null) then
    raise exception 'QA-unavailable task was not safely blocked';
  end if;
  if (select count(*) from private.fam_agent_task_events where task_id=task
      and event_type='blocked' and metadata->>'stage'='qa_unavailable') <> 1 then
    raise exception 'Missing or duplicate QA-unavailable event';
  end if;
  if exists(select 1 from private.fam_agent_task_events where task_id=task
      and metadata->>'stage' in ('qa_passed','qa_failed')) then
    raise exception 'Unavailable QA was reported as a pass or patch rejection';
  end if;
  -- Reject pre-generation, expired lease, different owner, approval-required task.
  for i in 4..6 loop
    task := ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','qa_failed') is distinct from false then
      raise exception 'Unexpected failure transition for fixture %',i;
    end if;
    if exists(select 1 from private.fam_agent_task_events where task_id=task) then
      raise exception 'Invalid transition created event';
    end if;
  end loop;
  -- Normal success path remains valid, including exact PR number.
  task := '00000000-0000-4000-8000-000000000007';
  if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','qa_passed') is distinct from true then
    raise exception 'QA success path regressed';
  end if;
  if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','pr_created',123) is distinct from true then
    raise exception 'PR transition regressed';
  end if;
  if not exists(select 1 from private.fam_agent_task_events where task_id=task
      and metadata->>'stage'='pr_created' and metadata->>'pr_number'='123') then
    raise exception 'Missing PR evidence';
  end if;
end $$;
reset role;
select 'PASS: QA rejection and unavailable runner are distinct; access and normal PR path unchanged' as result;
