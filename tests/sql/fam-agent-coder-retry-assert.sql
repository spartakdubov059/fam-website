insert into private.fam_site_error_counts(hour_bucket,event_code,page_area,event_count)
values (pg_catalog.now(),'js_runtime','other',4);

do $$
declare
  v_result jsonb;
  v_id uuid;
  v_count integer;
begin
  v_result := private.enqueue_fam_agent_coder_task();
  if v_result->>'task_created' <> 'true' then raise exception 'first task was not created: %', v_result; end if;
  v_id := (v_result->>'task_id')::uuid;
  v_result := private.enqueue_fam_agent_coder_task();
  if v_result->>'reason' <> 'coder_task_already_active' then raise exception 'active duplicate was not suppressed'; end if;
  update private.fam_agent_tasks set status='failed' where id=v_id;
  v_result := private.enqueue_fam_agent_coder_task();
  if v_result->>'reason' <> 'matching_coder_task_cooldown' then raise exception 'failed signature bypassed cooldown'; end if;
  update private.fam_agent_tasks set created_at=pg_catalog.now()-interval '8 days' where id=v_id;
  v_result := private.enqueue_fam_agent_coder_task();
  if v_result->>'task_created' <> 'true' then raise exception 'task was not reconsidered after cooldown'; end if;
  select count(*) into v_count from private.fam_agent_tasks
  where task_type='coder_patch_request' and payload->>'event_code'='js_runtime' and payload->>'page_area'='other';
  if v_count <> 2 then raise exception 'unexpected number of producer tasks: %', v_count; end if;
end;
$$;

insert into private.fam_agent_tasks (
  id,agent_key,task_type,title,description,priority,status,source,
  approval_required,payload,attempt_count,max_attempts,claimed_by,claimed_at,lease_expires_at
) values
  ('00000000-0000-4000-8000-000000000001','technical','coder_patch_request','retry','retry fixture','normal','claimed','scheduled_audit',false,'{}',1,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()+interval '2 hours'),
  ('00000000-0000-4000-8000-000000000002','technical','coder_patch_request','final','final fixture','normal','claimed','system',false,'{}',2,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()+interval '2 hours'),
  ('00000000-0000-4000-8000-000000000003','technical','coder_patch_request','expired','expired fixture','normal','claimed','system',false,'{}',1,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()-interval '1 minute'),
  ('00000000-0000-4000-8000-000000000004','technical','coder_patch_request','manual','manual fixture','normal','claimed','manual',false,'{}',1,2,'fam-agent-qwen-coder-v1',pg_catalog.now(),pg_catalog.now()+interval '2 hours'),
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
  v_saved := public.finish_fam_agent_coder_task('00000000-0000-4000-8000-000000000001','fam-agent-qwen-coder-v1','model_failed');
  if not v_saved then raise exception 'first transient failure was not accepted'; end if;
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
