do $$
declare
  task_id uuid;
  pr_number integer;
  head_sha text;
  merge_sha text;
begin
  if to_regprocedure('public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)') is null then
    raise exception 'Lifecycle resolver missing after reapply';
  end if;

  select e.task_id, (e.metadata->>'pr_number')::integer,
         e.metadata->>'head_sha', e.metadata->>'merge_commit_sha'
    into strict task_id, pr_number, head_sha, merge_sha
  from private.fam_agent_task_events e
  where e.metadata->>'stage' = 'postmerge_verified'
  limit 1;

  if public.resolve_fam_agent_coder_lifecycle(
    task_id, 'fam-agent-integrator-v1', 'postmerge_verified',
    pr_number, head_sha, merge_sha
  ) is distinct from true then
    raise exception 'Exact terminal replay failed after reapply';
  end if;

  if (select count(*) from private.fam_agent_task_events e
      where e.task_id = task_id and e.metadata->>'stage' = 'postmerge_verified') <> 1 then
    raise exception 'Reapply duplicated terminal lifecycle event';
  end if;
end $$;

select 'PASS: resolver re-applied; exact terminal replay remains idempotent' as result;
