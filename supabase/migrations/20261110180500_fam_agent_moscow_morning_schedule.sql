-- Moscow reporting schedule for FAM agents.
-- Supabase pg_cron uses GMT/UTC. Moscow is UTC+3, so 07:00 MSK = 04:00 UTC.
-- Keep the worker on a short polling interval; it is a queue dispatcher, not a full site audit.
-- Full scheduled checks run less frequently to avoid needless task churn.

do $$
declare
  v_definition text;
  v_old text;
  v_new text;
  v_job record;
  v_job_id bigint;
begin
  select pg_get_functiondef(
    'public.get_fam_agent_task_system_health(uuid,text)'::regprocedure
  ) into v_definition;

  v_old := $old$('fam-agent-school-daily-report','0 6 * * *')$old$;
  v_new := $new$('fam-agent-school-daily-report','30 3 * * *')$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected school report schedule not found.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$('fam-agent-orchestrator-daily-digest','5 6 * * *')$old$;
  v_new := $new$('fam-agent-orchestrator-daily-digest','0 4 * * *')$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected daily digest schedule not found.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$('fam-agent-technical-system-health','10 6 * * *')$old$;
  v_new := $new$('fam-agent-technical-system-health','40 3 * * *')$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected system health schedule not found.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$('fam-agent-site-error-audit','*/15 * * * *')$old$;
  v_new := $new$('fam-agent-site-error-audit','30 * * * *')$new$;
  if position(v_old in v_definition) = 0 then
    raise exception 'Expected site error audit schedule not found.';
  end if;
  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;

  for v_job in
    select * from (values
      ('fam-agent-school-daily-report', '30 3 * * *'),
      ('fam-agent-orchestrator-daily-digest', '0 4 * * *'),
      ('fam-agent-technical-system-health', '40 3 * * *'),
      ('fam-agent-site-error-audit', '30 * * * *')
    ) as schedules(job_name, new_schedule)
  loop
    select j.jobid into v_job_id
    from cron.job as j
    where j.jobname = v_job.job_name;

    if v_job_id is null then
      raise exception 'Required cron job % was not found.', v_job.job_name;
    end if;

    perform cron.alter_job(v_job_id, schedule => v_job.new_schedule);
    v_job_id := null;
  end loop;
end
$$;
