-- Prevent a recurring telemetry signature from enqueueing a new coder task
-- every day after the previous task completes or exhausts its bounded retry.
-- Serialize producer invocations so concurrent cron/manual calls cannot race
-- past the active-task and cooldown checks.
create or replace function private.enqueue_fam_agent_coder_task()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_event record;
  v_task_key text;
  v_task_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('fam-agent-coder-task-producer')::bigint
  );

  select c.event_code,c.page_area,sum(c.event_count)::integer as occurrences
  into v_event
  from private.fam_site_error_counts as c
  where c.hour_bucket >= pg_catalog.now() - interval '24 hours'
    and c.event_code in ('js_runtime','unhandled_rejection','listings_load_failed')
  group by c.event_code,c.page_area
  having sum(c.event_count) >= 3
  order by sum(c.event_count) desc,c.event_code,c.page_area
  limit 1;

  if not found then
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','no_threshold_event');
  end if;

  v_task_key := case
    when v_event.event_code in ('js_runtime','unhandled_rejection') then 'audit_frontend_runtime'
    when v_event.event_code = 'listings_load_failed' then 'audit_client_resilience'
    else 'audit_accessibility'
  end;

  if exists (
    select 1 from private.fam_agent_tasks as t
    where t.agent_key='technical'
      and t.task_type='coder_patch_request'
      and t.status in ('queued','claimed','in_progress')
  ) then
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','coder_task_already_active');
  end if;

  if exists (
    select 1 from private.fam_agent_tasks as t
    where t.agent_key='technical'
      and t.task_type='coder_patch_request'
      and t.source in ('system','scheduled_audit')
      and t.created_at >= pg_catalog.now() - interval '7 days'
      and t.payload->>'task_key' = v_task_key
      and t.payload->>'event_code' = v_event.event_code
      and t.payload->>'page_area' = v_event.page_area
  ) then
    return pg_catalog.jsonb_build_object('ok',true,'task_created',false,'reason','matching_coder_task_cooldown');
  end if;

  insert into private.fam_agent_tasks(
    agent_key,task_type,title,description,priority,status,source,
    approval_required,payload,max_attempts
  ) values (
    'technical',
    'coder_patch_request',
    'Безопасный анализ технического события FAM',
    'Провести только локальный анализ публичного клиентского кода по заранее разрешённой теме. Не читать пользовательские данные и не менять production.',
    'normal',
    'queued',
    'scheduled_audit',
    false,
    pg_catalog.jsonb_build_object(
      'task_key',v_task_key,
      'event_code',v_event.event_code,
      'page_area',v_event.page_area,
      'occurrences',least(greatest(v_event.occurrences,0),1000)
    ),
    2
  ) returning id into v_task_id;

  return pg_catalog.jsonb_build_object('ok',true,'task_created',true,'task_id',v_task_id);
end;
$function$;

revoke all on function private.enqueue_fam_agent_coder_task() from public,anon,authenticated;
grant execute on function private.enqueue_fam_agent_coder_task() to postgres,service_role;
