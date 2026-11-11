grant usage on schema cron to service_role;

grant select (jobid, jobname, schedule, active)
  on table cron.job to service_role;

grant select (jobid, status, start_time)
  on table cron.job_run_details to service_role;
