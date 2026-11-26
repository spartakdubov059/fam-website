do $$
declare
  tasks_before jsonb;
  events_before jsonb;
  tasks_after jsonb;
  events_after jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id::text), '[]'::jsonb)
    into tasks_before from private.fam_agent_tasks t;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at, e.task_id, e.event_type, e.metadata::text), '[]'::jsonb)
    into events_before from private.fam_agent_task_events e;

  if to_regprocedure('public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)') is not null then
    raise exception 'Lifecycle resolver still exists after rollback';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.id::text), '[]'::jsonb)
    into tasks_after from private.fam_agent_tasks t;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at, e.task_id, e.event_type, e.metadata::text), '[]'::jsonb)
    into events_after from private.fam_agent_task_events e;

  if tasks_after is distinct from tasks_before or events_after is distinct from events_before then
    raise exception 'Rollback changed task rows or lifecycle event history';
  end if;
end $$;

select 'PASS: lifecycle resolver removed; task and event history preserved' as result;
