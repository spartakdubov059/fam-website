insert into private.fam_agent_tasks
  (id,agent_key,task_type,approval_required,source,status,result_summary,
   claimed_by,claimed_at,lease_expires_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000008','technical','coder_patch_request',false,'system','in_progress',
   'Модель подготовила предложение; независимая QA ещё не подтверждена.',
   'fam-agent-qwen-coder-v1',now(),now()+interval '1 hour',now());

create temporary table qa_rollback_task_snapshot as
select coalesce(jsonb_agg(to_jsonb(t) order by t.id::text),'[]'::jsonb) as data
from private.fam_agent_tasks t;
create temporary table qa_rollback_event_snapshot as
select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at,e.task_id,e.event_type,e.metadata::text),'[]'::jsonb) as data
from private.fam_agent_task_events e;
