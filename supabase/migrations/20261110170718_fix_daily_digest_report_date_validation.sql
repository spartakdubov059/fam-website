create or replace function public.get_fam_agent_task_daily_digest(
  p_task_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_report_date date;
  v_digest jsonb;
begin
  if p_task_id is null
     or p_worker_id is null
     or pg_catalog.char_length(pg_catalog.btrim(p_worker_id)) not between 1 and 80 then
    return null;
  end if;

  select
    case
      when t.payload ->> 'report_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        then (t.payload ->> 'report_date')::date
      else null
    end
  into v_report_date
  from private.fam_agent_tasks as t
  where t.id = p_task_id
    and t.agent_key = 'orchestrator'
    and t.task_type = 'daily_report_digest'
    and t.approval_required = false
    and t.claimed_by = p_worker_id
    and t.status = 'claimed'
    and t.lease_expires_at > pg_catalog.now();

  if v_report_date is null then
    return null;
  end if;

  select pg_catalog.jsonb_build_object(
    'report_date', r.report_date,
    'generated_at', r.generated_at,
    'active_listings',
      coalesce(nullif(r.metrics #>> '{listings,active}', '')::integer, 0),
    'new_listings_24h',
      coalesce(nullif(r.metrics #>> '{listings,new_24h}', '')::integer, 0),
    'pending_ideas',
      coalesce(nullif(r.metrics #>> '{ideas,pending}', '')::integer, 0),
    'queued_tasks',
      coalesce(nullif(r.metrics #>> '{tasks,queued}', '')::integer, 0),
    'completed_tasks_24h',
      coalesce(nullif(r.metrics #>> '{tasks,completed_24h}', '')::integer, 0),
    'blocked_tasks_24h',
      coalesce(nullif(r.metrics #>> '{tasks,blocked_24h}', '')::integer, 0),
    'failed_tasks_24h',
      coalesce(nullif(r.metrics #>> '{tasks,failed_24h}', '')::integer, 0)
  )
  into v_digest
  from private.fam_agent_daily_reports as r
  where r.report_date = v_report_date;

  return v_digest;
end;
$function$;
