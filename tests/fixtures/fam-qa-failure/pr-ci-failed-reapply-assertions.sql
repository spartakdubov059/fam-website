insert into private.fam_agent_tasks
  (id,agent_key,task_type,approval_required,source,status,result_summary,
   claimed_by,claimed_at,lease_expires_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000013','technical','coder_patch_request',false,'system','in_progress',
   'Независимая QA прошла; PR ещё не создан.',
   'fam-agent-qwen-coder-v1',now(),now()+interval '1 hour',now());

do $$
declare task constant uuid := '00000000-0000-4000-8000-000000000013';
begin
  if public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','pr_ci_failed',235) is distinct from true then
    raise exception 'Reapplied migration did not accept PR CI failure';
  end if;
  if (select count(*) from private.fam_agent_task_events where task_id=task
      and event_type='blocked' and metadata->>'stage'='pr_ci_failed' and metadata->>'pr_number'='235') <> 1 then
    raise exception 'Reapplied migration omitted PR CI failure evidence';
  end if;
end $$;

select 'PASS: reapply records PR CI failure separately from QA' as result;
