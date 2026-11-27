insert into private.fam_agent_tasks
  (id,agent_key,task_type,approval_required,source,status,result_summary,
   claimed_by,claimed_at,lease_expires_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000009','technical','coder_patch_request',false,'system','in_progress',
   'Модель подготовила предложение; независимая QA ещё не подтверждена.',
   'fam-agent-qwen-coder-v1',now(),now()+interval '1 hour',now());

do $$
begin
  if to_regprocedure('public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)') is null then
    raise exception 'QA reapply removed the earlier lifecycle resolver';
  end if;
  if public.advance_fam_agent_coder_task(
    '00000000-0000-4000-8000-000000000009',
    'fam-agent-qwen-coder-v1','qa_failed'
  ) is distinct from true then
    raise exception 'Reapplied migration did not accept first-attempt QA failure';
  end if;
  if public.advance_fam_agent_coder_task(
    '00000000-0000-4000-8000-000000000009',
    'fam-agent-qwen-coder-v1','qa_failed'
  ) is distinct from false then
    raise exception 'Reapplied migration accepted duplicate QA failure';
  end if;
  if not exists(select 1 from private.fam_agent_tasks
      where id='00000000-0000-4000-8000-000000000009' and status='blocked'
        and claimed_by is null and claimed_at is null and lease_expires_at is null) then
    raise exception 'Reapplied migration did not stop the task safely';
  end if;
  if (select count(*) from private.fam_agent_task_events
      where task_id='00000000-0000-4000-8000-000000000009'
        and event_type='blocked' and metadata->>'stage'='qa_failed') <> 1 then
    raise exception 'Reapplied migration created missing or duplicate event';
  end if;
  if exists(select 1 from private.fam_agent_task_events
      where task_id='00000000-0000-4000-8000-000000000009'
        and metadata->>'stage'='qa_passed') then
    raise exception 'QA failure was reported as a pass';
  end if;
end $$;

insert into private.fam_agent_tasks
  (id,agent_key,task_type,approval_required,source,status,result_summary,
   claimed_by,claimed_at,lease_expires_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000011','technical','coder_patch_request',false,'system','in_progress',
   'Модель подготовила предложение; независимая QA ещё не подтверждена.',
   'fam-agent-qwen-coder-v1',now(),now()+interval '1 hour',now());

do $$
begin
  if public.advance_fam_agent_coder_task(
    '00000000-0000-4000-8000-000000000011',
    'fam-agent-qwen-coder-v1','qa_unavailable'
  ) is distinct from true then
    raise exception 'Reapplied migration did not distinguish unavailable QA';
  end if;
  if (select count(*) from private.fam_agent_task_events
      where task_id='00000000-0000-4000-8000-000000000011'
        and event_type='blocked' and metadata->>'stage'='qa_unavailable') <> 1 then
    raise exception 'Reapplied migration omitted QA-unavailable evidence';
  end if;
end $$;

select 'PASS: reapply distinguishes a rejected patch from an unavailable QA runner' as result;
