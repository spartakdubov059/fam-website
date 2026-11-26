do $$
begin
  if public.advance_fam_agent_coder_task(
    '00000000-0000-4000-8000-000000000008',
    'fam-agent-qwen-coder-v1','qa_failed'
  ) is distinct from false then
    raise exception 'Rollback did not restore the previous QA-failure contract';
  end if;
  if (select data from qa_rollback_task_snapshot) is distinct from
     (select coalesce(jsonb_agg(to_jsonb(t) order by t.id::text),'[]'::jsonb) from private.fam_agent_tasks t) then
    raise exception 'Rollback or rejected transition changed task rows';
  end if;
  if (select data from qa_rollback_event_snapshot) is distinct from
     (select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at,e.task_id,e.event_type,e.metadata::text),'[]'::jsonb) from private.fam_agent_task_events e) then
    raise exception 'Rollback or rejected transition changed event history';
  end if;
  if has_function_privilege('anon','public.advance_fam_agent_coder_task(uuid,text,text,integer)','execute')
     or has_function_privilege('authenticated','public.advance_fam_agent_coder_task(uuid,text,text,integer)','execute')
     or not has_function_privilege('service_role','public.advance_fam_agent_coder_task(uuid,text,text,integer)','execute') then
    raise exception 'Rollback changed RPC execution grants';
  end if;
end $$;

select 'PASS: rollback restores original QA failure contract and leaves task/event rows unchanged' as result;
