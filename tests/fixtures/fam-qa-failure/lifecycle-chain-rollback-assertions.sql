do $$
begin
  if to_regprocedure('public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)') is not null then
    raise exception 'Lifecycle rollback did not remove only the resolver function';
  end if;
  if (select data from lifecycle_chain_task_snapshot) is distinct from
     (select coalesce(jsonb_agg(to_jsonb(t) order by t.id::text),'[]'::jsonb) from private.fam_agent_tasks t) then
    raise exception 'Lifecycle rollback changed task rows';
  end if;
  if (select data from lifecycle_chain_event_snapshot) is distinct from
     (select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at,e.id),'[]'::jsonb) from private.fam_agent_task_events e) then
    raise exception 'Lifecycle rollback changed lifecycle evidence';
  end if;
end $$;

select 'PASS: rollback order preserves task and event evidence' as result;
