-- Disposable fixture for the coder completion metadata migration.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema private;

create table private.fam_agent_tasks (
  id uuid primary key,
  agent_key text not null,
  task_type text not null,
  approval_required boolean not null,
  claimed_by text,
  status text not null check (status in ('queued','claimed','in_progress','blocked','completed','failed','cancelled')),
  lease_expires_at timestamptz,
  result_summary text,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create table private.fam_agent_task_events (
  task_id uuid not null,
  event_type text not null check (event_type in ('created','claimed','started','progress','blocked','completed','failed','cancelled','retry_scheduled')),
  actor text not null,
  summary text not null
);
