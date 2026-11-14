do $$
begin
  if (select count(*) from private.fam_agent_tasks where status='failed') <> 9 then
    raise exception 'migration changed historical failures with unknown causes';
  end if;
  if exists (select 1 from private.fam_agent_task_events where event_type='retry_scheduled') then
    raise exception 'migration scheduled a retry for a historical failure';
  end if;
  update private.fam_agent_tasks set status='completed', finished_at=pg_catalog.now()
  where status='queued';
end;
$$;

insert into private.fam_site_error_counts(hour_bucket,event_code,page_area,event_count)
values (pg_catalog.now(),'unhandled_rejection','auth',4);

set role service_role;
do $$
declare
  v_result jsonb;
  v_id uuid;
  v_payload jsonb;
  v_producer_definition text;
  v_retry_id uuid;
  v_claimed_id uuid;
  v_count integer;
  v_status text;
  v_attempt integer;
  v_available timestamptz;
  v_finished timestamptz;
  v_claimed_by text;
  v_event text;
begin
  v_result := private.enqueue_fam_agent_coder_task();
  if v_result->>'task_created' <> 'true' then raise exception 'first task was not created: %', v_result; end if;
  v_id := (v_result->>'task_id')::uuid;
  select payload into v_payload from private.fam_agent_tasks where id=v_id;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_payload)) <> 4 then
    raise exception 'legacy claim RPC received an unexpected payload shape';
  end if;
  select pg_catalog.pg_get_functiondef('private.enqueue_fam_agent_coder_task()'::regprocedure)
    into v_producer_definition;
  if pg_catalog.strpos(v_producer_definition,'pg_advisory_xact_lock')=0 then
    raise exception 'producer is not serialized against concurrent enqueue calls';
  end if;

  v_result := private.enqueue_fam_agent_coder_task();
  if v_result->>'reason' <> 'coder_task_already_active' then raise exception 'active duplicate was not suppressed'; end if;
  update private.fam_agent_tasks set status='failed' where id=v_id;
  v_result := private.enqueue_fam_agent_coder_task();
  if v_result->>'reason' <> 'matching_coder_task_cooldown' then raise exception 'failed signature bypassed cooldown'; end if;
  update private.fam_agent_tasks set created_at=pg_catalog.now()-interval '8 days' where id=v_id;
  v_result := private.enqueue_fam_agent_coder_task();
  if v_result->>'task_created' <> 'true' then raise exception 'task was not reconsidered after cooldown'; end if;
  v_retry_id := (v_result->>'task_id')::uuid;
  select count(*) into v_count from private.fam_agent_tasks
  where task_type='coder_patch_request' and agent_key='technical' and source in ('system','scheduled_audit') and payload->>'task_key'='audit_frontend_runtime' and payload->>'event_code'='unhandled_rejection' and payload->>'page_area'='auth';
  if v_count <> 2 then raise exception 'unexpected number of producer tasks: %', v_count; end if;

  -- Exercise the existing production claim RPC, then the bounded failure path.
  v_claimed_id := null;
  select id into v_claimed_id
  from public.claim_fam_agent_coder_tasks('fam-agent-qwen-coder-v1',1,7200);
  if v_claimed_id is distinct from v_retry_id then raise exception 'producer task was not claimed'; end if;
  select attempt_count into v_attempt from private.fam_agent_tasks where id=v_retry_id;
  if v_attempt <> 1 then raise exception 'first claim did not increment attempt count'; end if;

  if not public.finish_fam_agent_coder_task(v_retry_id,'fam-agent-qwen-coder-v1','model_timeout') then
    raise exception 'first reported failure was not accepted';
  end if;
  select status,attempt_count,available_at,finished_at,claimed_by
  into v_status,v_attempt,v_available,v_finished,v_claimed_by
  from private.fam_agent_tasks where id=v_retry_id;
  if v_status <> 'queued' or v_attempt <> 1 or v_available < pg_catalog.now()+interval '29 minutes'
     or v_available > pg_catalog.now()+interval '31 minutes' or v_finished is not null or v_claimed_by is not null then
    raise exception 'first failure did not schedule exactly one delayed retry';
  end if;
  select event_type into v_event from private.fam_agent_task_events
  where task_id=v_retry_id order by id desc limit 1;
  if v_event <> 'retry_scheduled' then raise exception 'retry event was not recorded'; end if;

  select count(*) into v_count
  from public.claim_fam_agent_coder_tasks('fam-agent-qwen-coder-v1',1,7200);
  if v_count <> 0 then raise exception 'retry was claimable before cooldown elapsed'; end if;

  update private.fam_agent_tasks set available_at=pg_catalog.now()-interval '1 second' where id=v_retry_id;
  v_claimed_id := null;
  select id into v_claimed_id
  from public.claim_fam_agent_coder_tasks('fam-agent-qwen-coder-v1',1,7200);
  if v_claimed_id is distinct from v_retry_id then raise exception 'due retry was not claimed'; end if;
  select attempt_count into v_attempt from private.fam_agent_tasks where id=v_retry_id;
  if v_attempt <> 2 then raise exception 'retry claim did not increment attempt count'; end if;

  if not public.finish_fam_agent_coder_task(v_retry_id,'fam-agent-qwen-coder-v1','model_timeout') then
    raise exception 'final failure was not accepted';
  end if;
  select status,finished_at into v_status,v_finished from private.fam_agent_tasks where id=v_retry_id;
  if v_status <> 'failed' or v_finished is null then raise exception 'last attempt did not terminate'; end if;
  select event_type into v_event from private.fam_agent_task_events
  where task_id=v_retry_id order by id desc limit 1;
  if v_event <> 'failed' then raise exception 'terminal failure event was not recorded'; end if;

  v_result := private.enqueue_fam_agent_coder_task();
  if v_result->>'reason' <> 'matching_coder_task_cooldown' then
    raise exception 'failed retry signature bypassed producer cooldown';
  end if;
end;
$$;
reset role;

insert into private.fam_agent_tasks (
  id,agent_key,task_type,title,description,priority,status,source,
  approval_required,payload,attempt_count,max_attempts,claimed_by,claimed_at,lease_expires_at
) values
  ('00000000-0000-4000-8000-000000000001','technical','coder_patch_request','retry','retry fixture','normal','claimed','scheduled_audit',false,'{}',1,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()+interval '2 hours'),
  ('00000000-0000-4000-8000-000000000002','technical','coder_patch_request','final','final fixture','normal','claimed','system',false,'{}',2,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()+interval '2 hours'),
  ('00000000-0000-4000-8000-000000000003','technical','coder_patch_request','expired','expired fixture','normal','claimed','system',false,'{}',1,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()-interval '1 minute'),
  ('00000000-0000-4000-8000-000000000004','technical','coder_patch_request','manual','manual fixture','normal','claimed','manual',false,'{}',1,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()+interval '2 hours'),
  ('00000000-0000-4000-8000-000000000006','technical','coder_patch_request','unknown','unknown fixture','normal','claimed','system',false,'{}',1,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()+interval '2 hours'),
  ('00000000-0000-4000-8000-000000000005','technical','coder_patch_request','invalid','invalid fixture','normal','claimed','system',false,'{}',1,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()+interval '2 hours');

set role service_role;
do $$
declare
  v_saved boolean;
  v_status text;
  v_attempt integer;
  v_available timestamptz;
  v_finished timestamptz;
  v_claimed_by text;
  v_event text;
begin
  if not public.finish_fam_agent_coder_task('00000000-0000-4000-8000-000000000006','fam-agent-qwen-coder-v1','model_failed') then raise exception 'unknown failure rejected'; end if;
  if (select status from private.fam_agent_tasks where id='00000000-0000-4000-8000-000000000006') <> 'failed' then raise exception 'unknown failure retried'; end if;
  v_saved := public.finish_fam_agent_coder_task('00000000-0000-4000-8000-000000000001','fam-agent-qwen-coder-v1','model_timeout');
  if not v_saved then raise exception 'first reported failure was not accepted'; end if;
  select status,attempt_count,available_at,finished_at,claimed_by into v_status,v_attempt,v_available,v_finished,v_claimed_by
  from private.fam_agent_tasks where id='00000000-0000-4000-8000-000000000001';
  if v_status <> 'queued' or v_attempt <> 1 or v_available < pg_catalog.now()+interval '29 minutes'
     or v_available > pg_catalog.now()+interval '31 minutes' or v_finished is not null or v_claimed_by is not null then
    raise exception 'first failure did not schedule exactly one delayed retry';
  end if;
  select event_type into v_event from private.fam_agent_task_events where task_id='00000000-0000-4000-8000-000000000001';
  if v_event <> 'retry_scheduled' then raise exception 'retry event was not recorded'; end if;

  perform public.finish_fam_agent_coder_task('00000000-0000-4000-8000-000000000002','fam-agent-qwen-coder-v1','model_failed');
  select status,finished_at into v_status,v_finished from private.fam_agent_tasks where id='00000000-0000-4000-8000-000000000002';
  if v_status <> 'failed' or v_finished is null then raise exception 'final attempt did not terminate'; end if;
  if public.finish_fam_agent_coder_task('00000000-0000-4000-8000-000000000003','fam-agent-qwen-coder-v1','model_failed') then
    raise exception 'expired lease was accepted';
  end if;
  if public.finish_fam_agent_coder_task('00000000-0000-4000-8000-000000000004','fam-agent-qwen-coder-v1','model_failed') then
    raise exception 'manual task was accepted';
  end if;
  begin
    perform public.finish_fam_agent_coder_task('00000000-0000-4000-8000-000000000005','fam-agent-qwen-coder-v1','invalid_result');
    raise exception 'invalid result code was accepted';
  exception when raise_exception then
    if sqlerrm = 'invalid result code was accepted' or sqlerrm <> 'invalid coder result code' then raise; end if;
  end;
  begin
    perform public.finish_fam_agent_coder_task('00000000-0000-4000-8000-000000000005','wrong-worker','model_failed');
    raise exception 'wrong worker was accepted';
  exception when raise_exception then
    if sqlerrm = 'wrong worker was accepted' or sqlerrm <> 'invalid coder worker' then raise; end if;
  end;
end;
$$;
reset role;

set role anon;
do $$
begin
  begin
    perform public.finish_fam_agent_coder_task('00000000-0000-4000-8000-000000000002','fam-agent-qwen-coder-v1','model_failed');
    raise exception 'anon role could execute the finish RPC';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;
reset role;

insert into private.fam_agent_tasks (
  id,agent_key,task_type,title,description,priority,status,source,approval_required,
  payload,attempt_count,max_attempts,claimed_by,claimed_at,lease_expires_at
) values (
  '10000000-0000-4000-8000-000000000011','technical','coder_patch_request',
  'review state','synthetic QA gate fixture','normal','claimed','scheduled_audit',false,
  '{}',1,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()+interval '1 hour'
);

set role service_role;
do $$
declare
  v_saved boolean;
  v_status text;
  v_finished timestamptz;
  v_event text;
begin
  v_saved := public.finish_fam_agent_coder_task(
    '10000000-0000-4000-8000-000000000011',
    'fam-agent-qwen-coder-v1','model_completed'
  );
  select status,finished_at into v_status,v_finished
  from private.fam_agent_tasks where id='10000000-0000-4000-8000-000000000011';
  select event_type into v_event
  from private.fam_agent_task_events where task_id='10000000-0000-4000-8000-000000000011';
  if v_saved is distinct from true or v_status <> 'review' or v_finished is not null or v_event <> 'review' then
    raise exception 'legacy completion route bypassed the QA gate';
  end if;
end;
$$;
reset role;
