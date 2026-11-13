-- Disposable PostgreSQL fixture for the Reporter migration integration test.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema private;
create schema cron;
create schema net;

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

create table private.fam_site_error_counts (
  hour_bucket timestamptz not null,
  event_code text not null,
  page_area text not null,
  event_count integer not null check (event_count between 1 and 1000),
  primary key (hour_bucket, event_code, page_area)
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

create table net._http_response (
  id bigint primary key,
  status_code integer,
  content text,
  created timestamptz not null,
  timed_out boolean not null default false,
  error_msg text
);

insert into private.fam_agent_daily_reports (report_date, summary, metrics)
values (current_date - 1, 'previous daily report', '{"completed":2}'::jsonb);

insert into private.fam_site_error_counts (hour_bucket, event_code, page_area, event_count) values
  (date_trunc('hour', now()), 'js_runtime', 'listings', 4),
  (date_trunc('hour', now()), 'listings_load_failed', 'listings', 2);

insert into private.fam_agent_tasks (agent_key, task_type, status, updated_at) values
  ('technical', 'coder_patch_request', 'failed', now()),
  ('technical', 'site_error_digest', 'completed', now()),
  ('orchestrator', 'daily_report_digest', 'completed', now());

insert into cron.job (jobid, jobname, schedule, active)
values (1, 'fam-agent-worker-every-5-minutes', '*/5 * * * *', true);

insert into cron.job_run_details (jobid, status, start_time)
values (1, 'succeeded', now());


insert into net._http_response (id,status_code,content,created) values
  (1,200,'{"ok":true,"claimed":1,"completed":1,"blocked":0}',now()-interval '5 minutes'),
  (2,500,'{"ok":false,"error":"worker_execution_failed"}',now()-interval '3 minutes'),
  (3,200,'{"ok":true,"claimed":1,"completed":1,"blocked":0}',now()-interval '7 hours'),
  (4,400,'{"ok":false,"error":"unrelated_failure"}',now()-interval '2 minutes');
