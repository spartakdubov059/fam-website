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

-- Simulate recent terminal transient failures that predate the bounded retry migration.
insert into private.fam_agent_tasks (
  id,agent_key,task_type,title,description,priority,status,source,approval_required,
  payload,result_summary,attempt_count,max_attempts,created_at,updated_at,finished_at
) values
  ('10000000-0000-4000-8000-000000000001','technical','coder_patch_request','old transient A','synthetic fixture','normal','failed','scheduled_audit',false,
   '{"task_key":"audit_frontend_runtime","event_code":"js_runtime","page_area":"other","occurrences":4}',
   'Локальный анализатор завершился с ошибкой.',1,2,pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day'),
  ('10000000-0000-4000-8000-000000000002','technical','coder_patch_request','old transient duplicate','synthetic fixture','normal','failed','scheduled_audit',false,
   '{"task_key":"audit_frontend_runtime","event_code":"js_runtime","page_area":"other","occurrences":4}',
   'Локальный анализатор завершился с ошибкой.',1,2,pg_catalog.now()-interval '2 days',pg_catalog.now()-interval '2 days',pg_catalog.now()-interval '2 days'),
  ('10000000-0000-4000-8000-000000000003','technical','coder_patch_request','old transient B','synthetic fixture','normal','failed','scheduled_audit',false,
   '{"task_key":"audit_accessibility","event_code":"js_runtime","page_area":"other","occurrences":4}',
   'Локальный анализатор завершился с ошибкой.',1,2,pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day'),
  ('10000000-0000-4000-8000-000000000004','technical','coder_patch_request','active duplicate candidate','synthetic fixture','normal','failed','scheduled_audit',false,
   '{"task_key":"audit_client_resilience","event_code":"listings_load_failed","page_area":"listings","occurrences":4}',
   'Локальный анализатор завершился с ошибкой.',1,2,pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day'),
  ('10000000-0000-4000-8000-000000000005','technical','coder_patch_request','active duplicate','synthetic fixture','normal','queued','scheduled_audit',false,
   '{"task_key":"audit_client_resilience","event_code":"listings_load_failed","page_area":"listings","occurrences":4}',
   null,0,2,pg_catalog.now(),pg_catalog.now(),null),
  ('10000000-0000-4000-8000-000000000006','technical','coder_patch_request','exhausted failure','synthetic fixture','normal','failed','scheduled_audit',false,
   '{"task_key":"audit_frontend_runtime","event_code":"unhandled_rejection","page_area":"database","occurrences":4}',
   'Локальный анализатор завершился с ошибкой.',2,2,pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day'),
  ('10000000-0000-4000-8000-000000000007','technical','coder_patch_request','manual failure','synthetic fixture','normal','failed','manual',false,
   '{"task_key":"audit_accessibility","event_code":"unhandled_rejection","page_area":"auth","occurrences":4}',
   'Локальный анализатор завершился с ошибкой.',1,2,pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day'),
  ('10000000-0000-4000-8000-000000000008','technical','coder_patch_request','approval failure','synthetic fixture','normal','failed','scheduled_audit',true,
   '{"task_key":"audit_accessibility","event_code":"unhandled_rejection","page_area":"notifications","occurrences":4}',
   'Локальный анализатор завершился с ошибкой.',1,2,pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day'),
  ('10000000-0000-4000-8000-000000000009','technical','coder_patch_request','other failure','synthetic fixture','normal','failed','scheduled_audit',false,
   '{"task_key":"audit_accessibility","event_code":"unhandled_rejection","page_area":"notifications","occurrences":4}',
   'Другая ошибка.',1,2,pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day',pg_catalog.now()-interval '1 day'),
  ('10000000-0000-4000-8000-000000000010','technical','coder_patch_request','old stale failure','synthetic fixture','normal','failed','scheduled_audit',false,
   '{"task_key":"audit_accessibility","event_code":"unhandled_rejection","page_area":"auth","occurrences":4}',
   'Локальный анализатор завершился с ошибкой.',1,2,pg_catalog.now()-interval '8 days',pg_catalog.now()-interval '8 days',pg_catalog.now()-interval '8 days');
