do $test$
declare
  v_saved boolean;
  v_task private.fam_agent_tasks%rowtype;
begin
  if has_function_privilege('anon', 'public.finish_fam_agent_coder_task_with_pr(uuid,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.finish_fam_agent_coder_task_with_pr(uuid,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.finish_fam_agent_coder_task_with_pr(uuid,text,text,text,text)', 'EXECUTE') then
    raise exception 'coder finish RPC grants are incorrect';
  end if;

  insert into private.fam_agent_tasks(id,agent_key,task_type,approval_required,claimed_by,status,lease_expires_at)
  values ('123e4567-e89b-42d3-a456-426614174000','technical','coder_patch_request',false,
          'fam-agent-qwen-coder-v1','claimed',now()+interval '1 hour');

  v_saved := public.finish_fam_agent_coder_task_with_pr(
    '123e4567-e89b-42d3-a456-426614174000',
    'fam-agent-qwen-coder-v1',
    'model_completed',
    'https://github.com/spartakdubov059/fam-website/pull/65',
    '0123456789abcdef0123456789abcdef01234567'
  );
  select * into v_task from private.fam_agent_tasks
  where id='123e4567-e89b-42d3-a456-426614174000';
  if v_saved is distinct from true
     or v_task.status <> 'completed'
     or v_task.pr_url <> 'https://github.com/spartakdubov059/fam-website/pull/65'
     or v_task.commit_sha <> '0123456789abcdef0123456789abcdef01234567'
     or v_task.result_summary not like '%QA и обязательные проверки PR%' then
    raise exception 'successful coder completion was not tied to verified PR metadata';
  end if;

  insert into private.fam_agent_tasks(id,agent_key,task_type,approval_required,claimed_by,status,lease_expires_at)
  values ('723e4567-e89b-42d3-a456-426614174000','technical','coder_patch_request',false,
          'fam-agent-qwen-coder-v1','claimed',now()+interval '1 hour');
  v_saved := public.finish_fam_agent_coder_task_with_pr(
    '723e4567-e89b-42d3-a456-426614174000',
    'fam-agent-qwen-coder-v1','model_review',
    'https://github.com/spartakdubov059/fam-website/pull/76',
    '1123456789abcdef0123456789abcdef01234567'
  );
  select * into v_task from private.fam_agent_tasks
  where id='723e4567-e89b-42d3-a456-426614174000';
  if v_saved is distinct from true or v_task.status <> 'review'
     or v_task.pr_url is null or v_task.commit_sha is null then
    raise exception 'draft PR with a failed required check was not preserved for review';
  end if;

  insert into private.fam_agent_tasks(id,agent_key,task_type,approval_required,claimed_by,status,lease_expires_at)
  values ('223e4567-e89b-42d3-a456-426614174000','technical','coder_patch_request',false,
          'fam-agent-qwen-coder-v1','claimed',now()+interval '1 hour');
  update private.fam_agent_tasks set attempt_count=0 where id='223e4567-e89b-42d3-a456-426614174000';
  v_saved := public.finish_fam_agent_coder_task_with_pr(
    '223e4567-e89b-42d3-a456-426614174000',
    'fam-agent-qwen-coder-v1','model_failed',null,null
  );
  select * into v_task from private.fam_agent_tasks
  where id='223e4567-e89b-42d3-a456-426614174000';
  if v_saved is distinct from true or v_task.status <> 'failed'
     or v_task.pr_url is not null or v_task.commit_sha is not null then
    raise exception 'failed coder task incorrectly stored PR metadata';
  end if;

  insert into private.fam_agent_tasks(id,agent_key,task_type,approval_required,claimed_by,status,lease_expires_at)
  values ('323e4567-e89b-42d3-a456-426614174000','technical','coder_patch_request',false,
          'fam-agent-qwen-coder-v1','claimed',now()+interval '1 hour');
  v_saved := public.finish_fam_agent_coder_task_with_pr(
    '323e4567-e89b-42d3-a456-426614174000',
    'fam-agent-qwen-coder-v1','model_no_patch',null,null
  );
  select * into v_task from private.fam_agent_tasks
  where id='323e4567-e89b-42d3-a456-426614174000';
  if v_saved is distinct from true or v_task.status <> 'completed'
     or v_task.pr_url is not null or v_task.commit_sha is not null then
    raise exception 'no-patch result was not stored accurately';
  end if;

  insert into private.fam_agent_tasks(id,agent_key,task_type,approval_required,claimed_by,status,lease_expires_at)
  values ('623e4567-e89b-42d3-a456-426614174000','technical','coder_patch_request',false,
          'fam-agent-qwen-coder-v1','claimed',now()+interval '1 hour');

  begin
    perform public.finish_fam_agent_coder_task_with_pr(
      '623e4567-e89b-42d3-a456-426614174000',
      'fam-agent-qwen-coder-v1','model_completed',null,null
    );
    raise exception 'completed task without verified PR metadata was accepted';
  exception when raise_exception then
    if sqlerrm = 'completed task without verified PR metadata was accepted' then raise; end if;
  end;

  insert into private.fam_agent_tasks(id,agent_key,task_type,approval_required,claimed_by,status,lease_expires_at)
  values ('523e4567-e89b-42d3-a456-426614174000','technical','coder_patch_request',false,
          'fam-agent-qwen-coder-v1','claimed',now()+interval '1 hour');
  v_saved := public.finish_fam_agent_coder_task_with_pr(
    '523e4567-e89b-42d3-a456-426614174000',
    'fam-agent-qwen-coder-v1','model_timeout',null,null
  );
  select * into v_task from private.fam_agent_tasks
  where id='523e4567-e89b-42d3-a456-426614174000';
  if v_saved is distinct from true or v_task.status <> 'queued'
     or v_task.available_at < now()+interval '29 minutes'
     or v_task.available_at > now()+interval '31 minutes' then
    raise exception 'transient coder failure did not receive one delayed retry';
  end if;

  insert into private.fam_agent_tasks(id,agent_key,task_type,approval_required,claimed_by,status,lease_expires_at)
  values ('423e4567-e89b-42d3-a456-426614174000','technical','coder_patch_request',false,
          'fam-agent-qwen-coder-v1','claimed',now()+interval '1 hour');
  v_saved := public.finish_fam_agent_coder_task(
    '423e4567-e89b-42d3-a456-426614174000',
    'fam-agent-qwen-coder-v1','model_completed'
  );
  select * into v_task from private.fam_agent_tasks
  where id='423e4567-e89b-42d3-a456-426614174000';
  if v_saved is distinct from true or v_task.status <> 'review'
     or v_task.finished_at is not null or v_task.pr_url is not null then
    raise exception 'legacy finish route improperly completed a patch before QA/PR checks';
  end if;

  if (select count(*) from private.fam_agent_task_events) <> 6 then
    raise exception 'coder finish RPC did not write one event per task';
  end if;

  -- The retry scenario intentionally leaves one delayed queued task; clear it before testing the single-active-task producer.
  update private.fam_agent_tasks set status='completed'
  where task_type='coder_patch_request' and status in ('queued','claimed','in_progress');

  insert into private.fam_site_error_counts(event_code,page_area,hour_bucket,event_count)
  values ('js_runtime','other',now()-interval '1 hour',3);
  perform private.enqueue_fam_agent_coder_task();
  if (select count(*) from private.fam_agent_tasks
      where task_type='coder_patch_request' and payload->>'event_code'='js_runtime') <> 1 then
    raise exception 'producer did not enqueue the threshold event';
  end if;
  update private.fam_agent_tasks
  set status='completed',finished_at=now()
  where task_type='coder_patch_request' and payload->>'event_code'='js_runtime';
  if coalesce(private.enqueue_fam_agent_coder_task()->>'reason','') <> 'matching_coder_task_cooldown' then
    raise exception 'producer did not suppress the repeated event within seven days';
  end if;
  update private.fam_agent_tasks
  set created_at=now()-interval '8 days'
  where task_type='coder_patch_request' and payload->>'event_code'='js_runtime';
  perform private.enqueue_fam_agent_coder_task();
  if (select count(*) from private.fam_agent_tasks
      where task_type='coder_patch_request' and payload->>'event_code'='js_runtime') <> 2 then
    raise exception 'producer did not allow a new task after the seven-day cooldown';
  end if;
end
$test$;

select 'Coder queue QA/PR PostgreSQL integration checks passed' as result;
