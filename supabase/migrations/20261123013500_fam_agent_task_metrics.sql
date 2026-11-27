-- Aggregate-only agent metrics for the existing read-only control tower.
-- No task text, payload, identifiers, or student data leave the database.
create or replace function public.get_fam_agent_task_metrics()
returns table(agent_key text, status text, count bigint)
language sql
stable
security invoker
set search_path = ''
as $function$
  select t.agent_key, t.status, pg_catalog.count(*)
  from private.fam_agent_tasks as t
  group by t.agent_key, t.status
  order by t.agent_key, t.status;
$function$;

revoke all on function public.get_fam_agent_task_metrics() from public,anon,authenticated;
grant execute on function public.get_fam_agent_task_metrics() to service_role;
