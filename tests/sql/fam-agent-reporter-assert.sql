do $test$
declare
  v_snapshot jsonb;
  v_signal_count integer;
  v_technical jsonb;
  v_saved jsonb;
  v_stored jsonb;
  v_rejected boolean;
  v_report jsonb := jsonb_build_object(
    'report_date', to_char(current_date, 'YYYY-MM-DD'),
    'generated_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'sources', jsonb_build_object('supabase', 'available'),
    'supabase', null,
    'workflows_24h', '[]'::jsonb,
    'open_pull_requests', '[]'::jsonb,
    'role_statuses', jsonb_build_array(jsonb_build_object('role', 'Reporter', 'status', 'ready_to_store')),
    'technical_analysis', jsonb_build_object('status', 'no_allowlisted_signals', 'findings', '[]'::jsonb),
    'production_deployment', jsonb_build_object('status', 'success'),
    'public_site', jsonb_build_object('status', 'reachable', 'http_status', 200),
    'limitations', jsonb_build_array('Synthetic integration fixture'),
    'markdown', '# FAM synthetic report'
  );
begin
  if has_function_privilege('anon', 'public.get_fam_agent_report_snapshot()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.get_fam_agent_report_snapshot()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.get_fam_agent_report_snapshot()', 'EXECUTE') then
    raise exception 'snapshot function grants are incorrect';
  end if;

  if has_function_privilege('anon', 'public.save_fam_agent_system_report(date,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.save_fam_agent_system_report(date,jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.save_fam_agent_system_report(date,jsonb)', 'EXECUTE') then
    raise exception 'save function grants are incorrect';
  end if;

  v_snapshot := public.get_fam_agent_report_snapshot();
  select pg_catalog.jsonb_array_length(v_snapshot -> 'site_error_events_24h') into v_signal_count;
  select item into v_technical
  from jsonb_array_elements(v_snapshot -> 'agent_statuses') as item
  where item ->> 'agent_key' = 'technical';
  if v_signal_count <> 2
     or v_snapshot #>> '{site_error_events_24h,0,event_code}' <> 'js_runtime'
     or v_snapshot #>> '{site_error_events_24h,0,occurrences}' <> '4'
     or v_snapshot ->> 'report_date' <> to_char(current_date, 'YYYY-MM-DD')
     or v_snapshot #>> '{latest_coder_task,status}' <> 'failed'
     or v_snapshot #>> '{latest_system_health,status}' is not null
     or v_snapshot #>> '{cron_jobs,0,last_run_status}' <> 'succeeded'
     or pg_catalog.jsonb_array_length(v_snapshot -> 'cron_jobs') <> 2
     or v_snapshot #>> '{cron_jobs,1,jobname}' <> 'fam-listing-image-moderation-every-minute'
     or v_snapshot #>> '{cron_jobs,1,last_run_status}' <> 'failed'
     or v_snapshot #>> '{worker_http_6h,window_hours}' <> '6'
     or v_snapshot #>> '{worker_http_6h,response_count}' <> '2'
     or v_snapshot #>> '{worker_http_6h,success_count}' <> '1'
     or v_snapshot #>> '{worker_http_6h,http_error_count}' <> '1'
     or v_snapshot #>> '{worker_http_6h,reported_error_count}' <> '1'
     or v_snapshot #>> '{worker_http_6h,observed_from}' is null
     or v_snapshot::text like '%worker_execution_failed%'
     or v_snapshot::text like '%unrelated_failure%'
     or v_technical ->> 'failed_24h' <> '1'
     or v_snapshot #>> '{failed_tasks_24h,0,task_type}' <> 'coder_patch_request'
     or v_snapshot #>> '{daily_report,metrics,completed}' <> '2' then
    raise exception 'snapshot did not return the expected aggregate fields: %', v_snapshot;
  end if;

  v_saved := public.save_fam_agent_system_report(current_date, v_report);
  if v_saved ->> 'ok' <> 'true'
     or v_saved ->> 'report_date' <> to_char(current_date, 'YYYY-MM-DD') then
    raise exception 'save function did not confirm persistence';
  end if;

  select unified_report into v_stored
  from private.fam_agent_daily_reports
  where report_date = current_date;
  if v_stored is distinct from v_report then
    raise exception 'saved report differs from the bounded input';
  end if;

  perform public.save_fam_agent_system_report(
    current_date,
    v_report || jsonb_build_object('markdown', '# Updated synthetic report')
  );
  if (select count(*) from private.fam_agent_daily_reports where report_date = current_date) <> 1
     or (select unified_report ->> 'markdown' from private.fam_agent_daily_reports where report_date = current_date)
        <> '# Updated synthetic report' then
    raise exception 'same-day report update did not replace the previous report';
  end if;

  v_rejected := false;
  begin
    perform public.save_fam_agent_system_report(
      current_date,
      v_report || jsonb_build_object('private_payload', 'must not be accepted')
    );
  exception when others then
    v_rejected := sqlerrm = 'invalid FAM system report';
  end;
  if not v_rejected then
    raise exception 'unknown report fields were accepted';
  end if;

  v_rejected := false;
  begin
    perform public.save_fam_agent_system_report(
      current_date,
      v_report || jsonb_build_object('markdown', repeat('x', 66000))
    );
  exception when others then
    v_rejected := sqlerrm = 'invalid FAM system report';
  end;
  if not v_rejected then
    raise exception 'oversized report was accepted';
  end if;
end
$test$;

select 'Reporter PostgreSQL 17 integration checks passed' as result;
