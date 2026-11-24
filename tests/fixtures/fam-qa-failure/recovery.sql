-- Synthetic recovery tests for the actual repository claim RPC.
-- Only executed in the disposable fixture DB on GitHub's runner.
truncate private.fam_agent_task_events, private.fam_agent_tasks;
alter table private.fam_agent_tasks
  add column created_at timestamptz not null default now(),
  add column available_at timestamptz not null default now(),
  add column attempt_count integer not null default 0,
  add column max_attempts integer not null default 2,
  add column priority text not null default 'normal',
  add column payload jsonb not null default '{"task_key":"audit_agent_infrastructure","event_code":"qwen_repeated_failure","page_area":"agent_infrastructure","occurrences":3}';
insert into private.fam_agent_tasks
  (id,agent_key,task_type,approval_required,source,status,claimed_by,claimed_at,lease_expires_at,created_at,attempt_count)
select ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
  'technical','coder_patch_request',false,'scheduled_audit',
  case when i=3 then 'queued' else 'in_progress' end,
  case when i=3 then null else 'fam-agent-qwen-coder-v1' end,
  case when i=3 then null else now()-interval '2 hours' end,
  case when i=3 then null else now()-interval '1 hour' end,
  now()-case when i=3 then interval '8 days' else interval '2 hours' end,
  case when i=3 then 0 else i end
from generate_series(1,3) as i;
set role service_role;
do $$
declare
  first_id uuid := '00000000-0000-4000-8000-000000000001';
  exhausted_id uuid := '00000000-0000-4000-8000-000000000002';
  stale_id uuid := '00000000-0000-4000-8000-000000000003';
  claimed uuid;
begin
  select c.id into strict claimed from public.claim_fam_agent_coder_tasks('fam-agent-qwen-coder-v1',1,7200) c;
  if claimed <> first_id then raise exception 'Wrong recovered task'; end if;
  if not exists(select 1 from private.fam_agent_tasks where id=first_id and status='claimed'
      and attempt_count=2 and claimed_by='fam-agent-qwen-coder-v1' and lease_expires_at>now()) then
    raise exception 'Retry did not claim a fresh lease on the last permitted attempt';
  end if;
  if (select count(*) from private.fam_agent_tasks where id in(exhausted_id,stale_id) and status='failed'
      and claimed_by is null and lease_expires_at is null and finished_at is not null) <> 2 then
    raise exception 'Exhausted and stale tasks were not retired';
  end if;
  if (select count(*) from private.fam_agent_task_events where task_id=first_id and event_type='retry_scheduled') <> 1 then
    raise exception 'Missing or duplicate recovery event';
  end if;
  if exists(select 1 from public.claim_fam_agent_coder_tasks('fam-agent-qwen-coder-v1',1,7200)) then
    raise exception 'Unexpected extra claim';
  end if;
  if public.finish_fam_agent_coder_task(first_id,'fam-agent-qwen-coder-v1','model_failed') is distinct from true then
    raise exception 'Failed last attempt was not finalized';
  end if;
  if exists(select 1 from public.claim_fam_agent_coder_tasks('fam-agent-qwen-coder-v1',1,7200)) then
    raise exception 'Retry limit exceeded';
  end if;
  if (select count(*) from private.fam_agent_tasks where status='failed' and claimed_by is null and lease_expires_at is null) <> 3 then
    raise exception 'Recovery left an active task behind';
  end if;
end $$;
reset role;
select 'PASS: expired lease recovery, fresh second attempt, stale and exhausted tasks retired, no third attempt' as result;
