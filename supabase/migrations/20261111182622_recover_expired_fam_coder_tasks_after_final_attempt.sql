-- Recover Qwen coder tasks that exhausted retries while their final lease expired.
-- This is queue metadata only; it does not read or modify site/user content.

create or replace function public.claim_fam_agent_coder_tasks(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 7200
)
returns table (
  id uuid,
  task_key text,
  event_code text,
  page_area text,
  occurrences integer
)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_worker_id is distinct from 'fam-agent-qwen-coder-v1' then
    raise exception 'invalid coder worker';
  end if;

  -- An expired lease on the final permitted attempt must become a terminal failure.
  -- Without this cleanup such a task remains claimed forever and is never claimable again.
  with exhausted as (
    update private.fam_agent_tasks as t
    set status = 'failed',
        result_summary = 'Локальный анализатор исчерпал число попыток после истечения аренды.',
        claimed_by = null,
        claimed_at = null,
        lease_expires_at = null,
        finished_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where t.agent_key = 'technical'
      and t.task_type = 'coder_patch_request'
      and t.approval_required = false
      and t.status in ('claimed', 'in_progress')
      and t.lease_expires_at <= pg_catalog.now()
      and t.attempt_count >= t.max_attempts
    returning t.id
  )
  insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
  select
    e.id,
    'failed',
    'fam-agent-qwen-coder-v1',
    'Задание автоматически закрыто: истекла аренда последней разрешённой попытки.'
  from exhausted as e;

  return query
  with candidates as (
    select t.id
    from private.fam_agent_tasks as t
    where t.agent_key = 'technical'
      and t.task_type = 'coder_patch_request'
      and t.approval_required = false
      and t.source in ('system', 'scheduled_audit')
      and t.available_at <= pg_catalog.now()
      and t.attempt_count < t.max_attempts
      and (
        t.status = 'queued'
        or (t.status in ('claimed', 'in_progress') and t.lease_expires_at < pg_catalog.now())
      )
      and pg_catalog.jsonb_typeof(t.payload) = 'object'
      and t.payload ?& array['task_key','event_code','page_area','occurrences']
      and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(t.payload)) = 4
      and t.payload->>'task_key' in (
        'audit_frontend_runtime',
        'audit_client_resilience',
        'audit_accessibility'
      )
      and t.payload->>'event_code' in (
        'js_runtime','unhandled_rejection','supabase_sdk_unavailable',
        'listings_load_failed','notifications_load_failed',
        'database_request_failed','auth_backend_failed'
      )
      and t.payload->>'page_area' in ('auth','listings','notifications','database','other')
      and pg_catalog.jsonb_typeof(t.payload->'occurrences') = 'number'
      and (t.payload->>'occurrences') ~ '^[0-9]{1,4}$'
      and (t.payload->>'occurrences')::integer between 0 and 1000
    order by
      case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
      t.created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 1)
  ), claimed as (
    update private.fam_agent_tasks as t
    set status = 'claimed',
        claimed_by = p_worker_id,
        claimed_at = pg_catalog.now(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(
          secs => least(greatest(coalesce(p_lease_seconds, 7200), 300), 7200)
        ),
        attempt_count = t.attempt_count + 1,
        updated_at = pg_catalog.now()
    from candidates as c
    where t.id = c.id
    returning t.id, t.payload
  ), logged as (
    insert into private.fam_agent_task_events(task_id,event_type,actor,summary)
    select c.id,'claimed',p_worker_id,'Ограниченное техническое задание передано локальному анализатору.'
    from claimed as c
    returning task_id
  )
  select
    c.id,
    c.payload->>'task_key',
    c.payload->>'event_code',
    c.payload->>'page_area',
    (c.payload->>'occurrences')::integer
  from claimed as c
  join logged as l on l.task_id = c.id;
end;
$function$;

revoke all on function public.claim_fam_agent_coder_tasks(text,integer,integer) from public,anon,authenticated;
grant execute on function public.claim_fam_agent_coder_tasks(text,integer,integer) to service_role;
