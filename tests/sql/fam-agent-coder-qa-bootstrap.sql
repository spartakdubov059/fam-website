-- Disposable fixture for the coder completion metadata migration.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema private;
create schema cron;
create function cron.schedule(text,text,text) returns bigint
language sql
as $$ select 1::bigint $$;

create table private.fam_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null,
  task_type text not null,
  title text not null default 'Test coder task',
  description text not null default 'Test coder task description',
  priority text not null default 'normal',
  approval_required boolean not null,
  source text not null default 'scheduled_audit',
  payload jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 1,
  max_attempts integer not null default 2,
  available_at timestamptz not null default now(),
  claimed_by text,
  claimed_at timestamptz,
  status text not null check (status in ('queued','claimed','in_progress','blocked','completed','failed','cancelled')),
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  result_summary text,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create table private.fam_site_error_counts (
  event_code text not null,
  page_area text not null,
  hour_bucket timestamptz not null,
  event_count integer not null check (event_count >= 0)
);

create table private.fam_agent_task_events (
  task_id uuid not null,
  event_type text not null check (event_type in ('created','claimed','started','progress','blocked','completed','failed','cancelled','retry_scheduled')),
  actor text not null,
  summary text not null
);
