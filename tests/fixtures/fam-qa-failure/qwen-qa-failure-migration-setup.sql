-- Synthetic-only PostgreSQL fixture, not a Supabase schema.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema private;
create table private.fam_agent_tasks (
  id uuid primary key, agent_key text not null, task_type text not null,
  approval_required boolean not null, source text not null, status text not null,
  result_summary text, claimed_by text, claimed_at timestamptz,
  started_at timestamptz, finished_at timestamptz, lease_expires_at timestamptz,
  updated_at timestamptz, payload jsonb not null default '{}'::jsonb
);
create table private.fam_agent_task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references private.fam_agent_tasks(id),
  event_type text not null, actor text not null, summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
grant usage on schema private to service_role;
grant select,update on private.fam_agent_tasks to service_role;
grant select,insert on private.fam_agent_task_events to service_role;
insert into private.fam_agent_tasks
(id,agent_key,task_type,approval_required,source,status,result_summary,claimed_by,claimed_at,lease_expires_at)
select ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
  'technical','coder_patch_request',i=6,'system','in_progress',
  case when i=2 then 'Независимая QA прошла; PR ещё не создан.'
    when i=3 then 'Задание принято локальным анализатором; независимая QA ещё не подтверждена.'
    else 'Модель подготовила предложение; независимая QA ещё не подтверждена.' end,
  case when i=5 then 'other-worker' else 'fam-agent-qwen-coder-v1' end,
  now(), now()+case when i=4 then interval '-1 hour' else interval '1 hour' end
from generate_series(1,7) as i;
