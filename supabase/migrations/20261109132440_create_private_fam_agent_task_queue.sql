
create table private.fam_agent_ideas (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  summary text not null check (char_length(btrim(summary)) between 10 and 1200),
  benefit text check (benefit is null or char_length(benefit) <= 600),
  complexity text not null default 'medium' check (complexity in ('small','medium','large')),
  risk text not null default 'low' check (risk in ('low','medium','high')),
  evidence_kind text not null default 'hypothesis' check (evidence_kind in ('observed','hypothesis')),
  evidence_summary text check (evidence_summary is null or char_length(evidence_summary) <= 1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected','queued','in_progress','completed')),
  proposed_by text not null default 'fam_growth_agent',
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.fam_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null check (agent_key in ('orchestrator','technical','database','moderation','safety','quality','growth')),
  task_type text not null check (char_length(btrim(task_type)) between 2 and 80),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  description text not null check (char_length(btrim(description)) between 10 and 2000),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'queued' check (status in ('queued','claimed','in_progress','blocked','completed','failed','cancelled')),
  source text not null default 'system' check (source in ('system','scheduled_audit','user_approved_idea','manual')),
  idea_id uuid references private.fam_agent_ideas(id) on delete set null,
  approval_required boolean not null default true,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  result_summary text check (result_summary is null or char_length(result_summary) <= 2000),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  available_at timestamptz not null default now(),
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.fam_agent_task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references private.fam_agent_tasks(id) on delete cascade,
  event_type text not null check (event_type in ('created','claimed','started','progress','blocked','completed','failed','cancelled','retry_scheduled')),
  actor text not null,
  summary text not null check (char_length(btrim(summary)) between 1 and 1000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index fam_agent_tasks_queue_idx
  on private.fam_agent_tasks (status, available_at, priority, created_at);
create index fam_agent_tasks_lease_idx
  on private.fam_agent_tasks (lease_expires_at)
  where status in ('claimed','in_progress');
create index fam_agent_ideas_review_idx
  on private.fam_agent_ideas (status, created_at desc);
create index fam_agent_task_events_task_idx
  on private.fam_agent_task_events (task_id, created_at desc);

alter table private.fam_agent_ideas enable row level security;
alter table private.fam_agent_tasks enable row level security;
alter table private.fam_agent_task_events enable row level security;

revoke all on table private.fam_agent_ideas, private.fam_agent_tasks, private.fam_agent_task_events from public, anon, authenticated;
grant select, insert, update, delete on table private.fam_agent_ideas, private.fam_agent_tasks, private.fam_agent_task_events to service_role;

comment on table private.fam_agent_ideas is 'Private FAM product ideas proposed by the growth analyst; do not store student personal data.';
comment on table private.fam_agent_tasks is 'Private FAM agent task queue. Tasks require explicit approval by default; do not place student messages or personal data in payload.';
comment on table private.fam_agent_task_events is 'Private, minimal audit trail for FAM agent task state changes; store summaries only, never raw student content.';
