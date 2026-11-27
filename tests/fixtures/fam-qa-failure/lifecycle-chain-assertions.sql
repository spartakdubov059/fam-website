-- Verify the lifecycle resolver still operates after the later QA-failure migration.
insert into private.fam_agent_tasks(
  id,agent_key,task_type,approval_required,source,status,result_summary,
  claimed_by,claimed_at,lease_expires_at,payload
) values (
  '00000000-0000-4000-8000-000000000010','technical','coder_patch_request',false,'system','in_progress',
  'PR создан после независимой QA; ожидает решения владельца.',
  null,null,null,jsonb_build_object('pr_number',123,'pr_head_sha',repeat('a',40),'lifecycle_state','pending_review')
);
insert into private.fam_agent_task_events(task_id,event_type,actor,summary,metadata)
values('00000000-0000-4000-8000-000000000010','progress','fam-agent-integrator-v1','PR создан','{"stage":"pr_created","pr_number":123}');

set role service_role;
do $$
declare
  task_id uuid := '00000000-0000-4000-8000-000000000010';
  worker text := 'fam-agent-integrator-v1';
  head_sha text := repeat('a',40);
  merge_sha text := repeat('b',40);
begin
  if public.resolve_fam_agent_coder_lifecycle(task_id,worker,'owner_approved',123,head_sha) is distinct from true
      or public.resolve_fam_agent_coder_lifecycle(task_id,worker,'merged',123,head_sha,merge_sha) is distinct from true
      or public.resolve_fam_agent_coder_lifecycle(task_id,worker,'postmerge_verified',123,head_sha,merge_sha) is distinct from true
      or public.resolve_fam_agent_coder_lifecycle(task_id,worker,'postmerge_verified',123,head_sha,merge_sha) is distinct from true then
    raise exception 'Lifecycle resolver did not complete and acknowledge exact terminal replay';
  end if;
  if (select count(*) from private.fam_agent_task_events as e where e.task_id=task_id) <> 4 then
    raise exception 'Lifecycle history is missing or has duplicate events';
  end if;
  if not exists(select 1 from private.fam_agent_tasks as t where t.id=task_id and t.status='completed'
       and t.payload->>'lifecycle_state'='completed' and t.payload->>'merge_commit_sha'=merge_sha) then
    raise exception 'Lifecycle completion state is incorrect';
  end if;
end $$;
reset role;

select 'PASS: lifecycle resolver still works after QA failure migration' as result;
