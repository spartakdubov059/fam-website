-- Disposable PostgreSQL fixture for the Reporter migration integration test.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema private;
create schema cron;

create table private.fam_agent_daily_reports (
  report_date date primary key,
  generated_at timestamptz not null default now(),
  summary text not null default '',
  metrics jsonb not null default '{}'::jsonb
);

create table private.fam_agent_tasks (
  agent_key text not null,
  task_type text not null,
  status text not null,
  updated_at timestamptz not null default now()
);

create table cron.job (
  jobid bigint primary key,
  jobname text not null,
  schedule text not null,
  active boolean not null
);

create table cron.job_run_details (
  jobid bigint not null,
  status text not null,
  start_time timestamptz not null
);

insert into private.fam_agent_daily_reports (report_date, summary, metrics)
values (current_date - 1, 'previous daily report', '{"completed":2}'::jsonb);

insert into private.fam_agent_tasks (agent_key, task_type, status, updated_at) values
  ('technical', 'coder_patch_request', 'failed', now()),
  ('technical', 'site_error_digest', 'completed', now()),
  ('orchestrator', 'daily_report_digest', 'completed', now());

insert into cron.job (jobid, jobname, schedule, active)
values (1, 'fam-agent-worker-every-5-minutes', '*/5 * * * *', true);

insert into cron.job_run_details (jobid, status, start_time)
values (1, 'succeeded', now());
