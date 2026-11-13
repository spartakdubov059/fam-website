do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      execute pg_catalog.format('create role %I', v_role);
    end if;
  end loop;
end;
$$;

create schema private;
grant usage on schema private to service_role;

create table private.fam_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null,
  task_type text not null,
  title text not null,
  description text not null,
  priority text not null,
  status text not null check (status in ('queued','claimed','in_progress','blocked','completed','failed','cancelled')),
  source text not null check (source in ('system','scheduled_audit','user_approved_idea','manual')),
  approval_required boolean not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  result_summary text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null check (max_attempts between 1 and 5),
  available_at timestamptz not null default now(),
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.fam_agent_task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references private.fam_agent_tasks(id),
  event_type text not null check (event_type in ('created','claimed','started','progress','blocked','completed','failed','cancelled','retry_scheduled')),
  actor text not null,
  summary text not null,
  created_at timestamptz not null default now()
);

create table private.fam_site_error_counts (
  hour_bucket timestamptz not null,
  event_code text not null,
  page_area text not null,
  event_count integer not null check (event_count >= 0)
);

grant select, insert, update, delete on private.fam_agent_tasks,
  private.fam_agent_task_events, private.fam_site_error_counts to service_role;
grant usage, select on all sequences in schema private to service_role;

-- Stand-in for pg_cron in the isolated PostgreSQL fixture. The production migration is otherwise applied verbatim.
create schema cron;
create function cron.schedule(text,text,text)
returns bigint language sql immutable as 'select 1::bigint';
