insert into private.fam_agent_tasks
  (id,agent_key,task_type,approval_required,source,status,result_summary,
   claimed_by,claimed_at,lease_expires_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000012','technical','coder_patch_request',false,'system','in_progress',
   'Независимая QA прошла; PR ещё не создан.',
   'fam-agent-qwen-coder-v1',now(),now()+interval '1 hour',now());

set role service_role;
do $$
declare task constant uuid := '00000000-0000-4000-8000-000000000012';
begin
  if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','pr_ci_failed',234) is distinct from true then
    raise exception 'PR CI failure was not recorded';
  end if;
  if not exists(select 1 from private.fam_agent_tasks where id=task and status='blocked'
      and result_summary='PR создан, но его независимый CI не прошёл; исправление не считается внедрённым.'
      and claimed_by is null and claimed_at is null and lease_expires_at is null) then
    raise exception 'PR CI failure did not block and release the task';
  end if;
  if (select count(*) from private.fam_agent_task_events where task_id=task
      and event_type='blocked' and metadata->>'stage'='pr_ci_failed'
      and metadata->>'pr_number'='234') <> 1 then
    raise exception 'PR CI failure evidence or PR number is missing';
  end if;
  if exists(select 1 from private.fam_agent_task_events where task_id=task
      and metadata->>'stage' in ('qa_failed','qa_passed')) then
    raise exception 'PR CI failure was misreported as QA result';
  end if;
  if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','pr_ci_failed',234) is distinct from false then
    raise exception 'Repeated PR CI failure was accepted';
  end if;
end $$;
reset role;

select 'PASS: failed PR CI remains distinct from QA and retains the PR reference' as result;
