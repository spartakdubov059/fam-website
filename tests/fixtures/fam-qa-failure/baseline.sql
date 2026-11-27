-- Demonstrate the exact original defect before installing candidate.
set role service_role;
do $$
begin
  if public.advance_fam_agent_coder_task('00000000-0000-4000-8000-000000000001','fam-agent-qwen-coder-v1','qa_failed') is distinct from false then
    raise exception 'Baseline no longer reproduces defect; review candidate';
  end if;
  if exists(select 1 from private.fam_agent_task_events) then
    raise exception 'Rejected baseline transition wrote an event';
  end if;
end $$;
reset role;
