create temporary table lifecycle_chain_task_snapshot as
select coalesce(jsonb_agg(to_jsonb(t) order by t.id::text),'[]'::jsonb) as data
from private.fam_agent_tasks t;
create temporary table lifecycle_chain_event_snapshot as
select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at,e.id),'[]'::jsonb) as data
from private.fam_agent_task_events e;
