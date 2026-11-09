-- FAM agent worker RPCs and supporting foreign-key indexes.
-- Applied to project tfacqpljrvfpcrhdovbu as migration 20261109134017.

create index if not exists fam_agent_ideas_reviewed_by_idx
  on private.fam_agent_ideas (reviewed_by);
create index if not exists fam_agent_tasks_idea_id_idx
  on private.fam_agent_tasks (idea_id);

create or replace function public.claim_fam_agent_tasks(
  p_worker_id text,
  p_limit integer default 3,
  p_lease_seconds integer default 120
)
returns table (
  id uuid,
  agent_key text,
  task_type text,
  approval_required boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_worker_id is null or pg_catalog.char_length(pg_catalog.btrim(p_worker_id)) not between 1 and 80 then
    raise exception 'invalid worker id';
  end if;

  with exhausted as (
    update private.fam_agent_tasks as t
    set status = 'failed',
        result_summary = 'Задача остановлена после исчерпания попыток.',
        claimed_by = null,
        lease_expires_at = null,
        finished_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where t.status in ('claimed', 'in_progress')
      and t.lease_expires_at < pg_catalog.now()
      and t.attempt_count >= t.max_attempts
    returning t.id
  )
  insert into private.fam_agent_task_events (task_id, event_type, actor, summary)
  select e.id, 'failed', p_worker_id, 'Задача остановлена после исчерпания попыток.'
  from exhausted as e;

  return query
  with candidates as (
    select t.id
    from private.fam_agent_tasks as t
    where t.approval_required = false
      and t.agent_key = 'quality'
      and t.task_type = 'queue_health_check'
      and t.available_at <= pg_catalog.now()
      and t.attempt_count < t.max_attempts
      and (
        t.status = 'queued'
        or (t.status in ('claimed', 'in_progress') and t.lease_expires_at < pg_catalog.now())
      )
    order by
      case t.priority
        when 'urgent' then 0
        when 'high' then 1
        when 'normal' then 2
        else 3
      end,
      t.created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 5)
  ), claimed as (
    update private.fam_agent_tasks as t
    set status = 'claimed',
        claimed_by = p_worker_id,
        claimed_at = pg_catalog.now(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(
          secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 300)
        ),
        attempt_count = t.attempt_count + 1,
        updated_at = pg_catalog.now()
    from candidates as c
    where t.id = c.id
    returning t.id, t.agent_key, t.task_type, t.approval_required
  ), logged as (
    insert into private.fam_agent_task_events (task_id, event_type, actor, summary)
    select c.id, 'claimed', p_worker_id, 'Задание передано безопасному исполнителю.'
    from claimed as c
    returning task_id
  )
  select c.id, c.agent_key, c.task_type, c.approval_required
  from claimed as c
  join logged as l on l.task_id = c.id;
end;
$$;

create or replace function public.finish_fam_agent_task(
  p_task_id uuid,
  p_worker_id text,
  p_status text,
  p_summary text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task_id uuid;
  v_summary text;
begin
  if p_worker_id is null
     or pg_catalog.char_length(pg_catalog.btrim(p_worker_id)) not between 1 and 80 then
    raise exception 'invalid worker id';
  end if;

  if p_status is null or p_status not in ('completed', 'blocked', 'failed') then
    raise exception 'invalid task status';
  end if;

  v_summary := pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(p_summary), ''), 'Задача обработана.'),
    1000
  );

  update private.fam_agent_tasks as t
  set status = p_status,
      result_summary = v_summary,
      claimed_by = null,
      lease_expires_at = null,
      finished_at = case when p_status in ('completed', 'failed') then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where t.id = p_task_id
    and t.claimed_by = p_worker_id
    and t.status = 'claimed'
    and t.lease_expires_at > pg_catalog.now()
  returning t.id into v_task_id;

  if v_task_id is null then
    return false;
  end if;

  insert into private.fam_agent_task_events (task_id, event_type, actor, summary)
  values (v_task_id, p_status, p_worker_id, v_summary);

  return true;
end;
$$;

revoke all on function public.claim_fam_agent_tasks(text, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_fam_agent_task(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_fam_agent_tasks(text, integer, integer) to service_role;
grant execute on function public.finish_fam_agent_task(uuid, text, text, text) to service_role;
