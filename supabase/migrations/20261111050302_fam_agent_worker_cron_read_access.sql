-- Let the backend worker read only the scheduler metadata used by the
-- read-only technical health RPC. No access is granted to client roles.
grant usage on schema cron to service_role;

grant select (jobid, jobname, schedule, active)
  on table cron.job to service_role;

grant select (jobid, status, start_time)
  on table cron.job_run_details to service_role;
