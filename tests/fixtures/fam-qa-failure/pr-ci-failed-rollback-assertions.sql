do $$
declare task constant uuid := '00000000-0000-4000-8000-000000000012';
begin
  begin
    perform public.advance_fam_agent_coder_task(task,'fam-agent-qwen-coder-v1','pr_ci_failed',234);
    raise exception 'Rollback left the PR-CI stage enabled';
  exception when raise_exception then
    if sqlerrm = 'Rollback left the PR-CI stage enabled' then raise; end if;
    if sqlerrm <> 'invalid coder lifecycle stage' then raise; end if;
  end;
  if not exists(select 1 from private.fam_agent_tasks where id=task and status='blocked'
      and result_summary='PR создан, но его независимый CI не прошёл; исправление не считается внедрённым.') then
    raise exception 'Rollback modified the blocked task record';
  end if;
  if (select count(*) from private.fam_agent_task_events where task_id=task
      and event_type='blocked' and metadata->>'stage'='pr_ci_failed' and metadata->>'pr_number'='234') <> 1 then
    raise exception 'Rollback modified retained event history';
  end if;
end $$;

select 'PASS: rollback preserves the PR-CI task and event evidence' as result;
