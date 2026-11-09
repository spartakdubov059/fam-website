-- School-scoped, content-free FAM admin reports and human-reviewed analyst ideas.
-- This migration never stores message text, direct user identifiers, email addresses, or raw moderation content.

-- Agent proposals are scoped to a school. Existing project-wide legacy ideas remain unassigned
-- (school_id IS NULL) and are intentionally not exposed in any school's dashboard.
alter table private.fam_agent_ideas
  add column if not exists school_id text
  references public.schools(id) on update cascade on delete cascade;

create index if not exists fam_agent_ideas_school_status_created_idx
  on private.fam_agent_ideas (school_id, status, created_at desc);

create table private.fam_agent_school_daily_reports (
  school_id text not null references public.schools(id) on update cascade on delete cascade,
  report_date date not null,
  generated_at timestamptz not null default pg_catalog.now(),
  summary text not null,
  metrics jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(metrics) = 'object'),
  primary key (school_id, report_date)
);

comment on table private.fam_agent_school_daily_reports is
  'School-scoped daily FAM report. Aggregate counts only; no private messages, raw content, email addresses, or user identifiers.';

alter table private.fam_agent_school_daily_reports enable row level security;
alter table private.fam_agent_school_daily_reports force row level security;

create policy deny_client_access_to_fam_agent_school_daily_reports
  on private.fam_agent_school_daily_reports
  for all to anon, authenticated
  using (false) with check (false);

revoke all on table private.fam_agent_school_daily_reports from public, anon, authenticated;
grant select, insert, update on table private.fam_agent_school_daily_reports to service_role;

create or replace function private.refresh_fam_agent_school_daily_reports()
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_school record;
  v_school_id text;
  v_report_date date := (pg_catalog.now() at time zone 'UTC')::date;
  v_generated_at timestamptz;
  v_metrics jsonb;
  v_summary text;
  v_count integer := 0;
begin
  for v_school in
    select s.id
    from public.schools as s
    order by s.id
  loop
    v_school_id := v_school.id;
    v_generated_at := pg_catalog.now();

    select pg_catalog.jsonb_build_object(
      'listings', pg_catalog.jsonb_build_object(
        'active', (
          select pg_catalog.count(*)::integer
          from public.listings as l
          left join public.profiles as p on p.id = l.user_id
          where coalesce(l.school_id, p.school_id) = v_school_id
            and l.status = 'active'
        ),
        'new_24h', (
          select pg_catalog.count(*)::integer
          from public.listings as l
          left join public.profiles as p on p.id = l.user_id
          where coalesce(l.school_id, p.school_id) = v_school_id
            and l.created_at >= pg_catalog.now() - interval '24 hours'
        )
      ),
      'safety', pg_catalog.jsonb_build_object(
        'unreviewed', (
          select pg_catalog.count(*)::integer
          from public.fam_safety_incidents as i
          where i.school_id = v_school_id and i.reviewed_at is null
        ),
        'high_unreviewed', (
          select pg_catalog.count(*)::integer
          from public.fam_safety_incidents as i
          where i.school_id = v_school_id
            and i.reviewed_at is null
            and i.severity = 'high'
        )
      ),
      'account_requests', pg_catalog.jsonb_build_object(
        'deletion_pending', (
          select pg_catalog.count(*)::integer
          from public.account_deletion_requests as r
          where r.school_id = v_school_id
            and r.status in ('pending', 'processing')
        ),
        'active_suspensions', (
          select pg_catalog.count(*)::integer
          from public.account_suspensions as s
          where s.school_id = v_school_id
            and s.status = 'active'
            and s.expires_at > pg_catalog.now()
        )
      ),
      'ideas', pg_catalog.jsonb_build_object(
        'awaiting_council', (
          select pg_catalog.count(*)::integer
          from public.ideas as i
          where i.school_id = v_school_id and i.admin_status = 'new'
        )
      ),
      'agent_proposals', pg_catalog.jsonb_build_object(
        'pending', (
          select pg_catalog.count(*)::integer
          from private.fam_agent_ideas as i
          where i.school_id = v_school_id and i.status = 'pending'
        )
      )
    ) into v_metrics;

    v_summary := pg_catalog.format(
      'FAM — сводка за %s: активных объявлений %s, новых за сутки %s; непроверенных сигналов безопасности %s, из них высокого уровня %s; запросов на удаление %s; идей ожидают Совет %s; предложений ИИ ждут решения %s; активных временных ограничений %s.',
      pg_catalog.to_char(v_report_date, 'DD.MM.YYYY'),
      v_metrics #>> '{listings,active}',
      v_metrics #>> '{listings,new_24h}',
      v_metrics #>> '{safety,unreviewed}',
      v_metrics #>> '{safety,high_unreviewed}',
      v_metrics #>> '{account_requests,deletion_pending}',
      v_metrics #>> '{ideas,awaiting_council}',
      v_metrics #>> '{agent_proposals,pending}',
      v_metrics #>> '{account_requests,active_suspensions}'
    );

    insert into private.fam_agent_school_daily_reports (
      school_id, report_date, generated_at, summary, metrics
    )
    values (
      v_school_id, v_report_date, v_generated_at, v_summary, v_metrics
    )
    on conflict (school_id, report_date) do update
      set generated_at = excluded.generated_at,
          summary = excluded.summary,
          metrics = excluded.metrics;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

revoke all on function private.refresh_fam_agent_school_daily_reports() from public, anon, authenticated;
grant execute on function private.refresh_fam_agent_school_daily_reports() to postgres;

create or replace function public.get_fam_agent_admin_dashboard(p_school_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_report jsonb;
  v_ideas jsonb;
begin
  if p_school_id is null
     or pg_catalog.length(pg_catalog.btrim(p_school_id)) = 0
     or not exists (select 1 from public.schools as s where s.id = p_school_id) then
    raise exception 'Недопустимая школа для отчёта.'
      using errcode = '22023';
  end if;

  select pg_catalog.jsonb_build_object(
    'school_id', r.school_id,
    'report_date', r.report_date,
    'generated_at', r.generated_at,
    'summary', r.summary,
    'metrics', r.metrics
  )
  into v_report
  from private.fam_agent_school_daily_reports as r
  where r.school_id = p_school_id
  order by r.report_date desc
  limit 1;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', pending.id,
        'title', pending.title,
        'summary', pending.summary,
        'benefit', pending.benefit,
        'complexity', pending.complexity,
        'risk', pending.risk,
        'evidence_kind', pending.evidence_kind,
        'evidence_summary', pending.evidence_summary,
        'proposed_by', pending.proposed_by,
        'created_at', pending.created_at
      )
      order by pending.created_at desc
    ),
    '[]'::jsonb
  )
  into v_ideas
  from (
    select i.id, i.title, i.summary, i.benefit, i.complexity, i.risk,
           i.evidence_kind, i.evidence_summary, i.proposed_by, i.created_at
    from private.fam_agent_ideas as i
    where i.school_id = p_school_id
      and i.status = 'pending'
    order by i.created_at desc
    limit 20
  ) as pending;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'report', v_report,
    'agent_ideas', v_ideas
  );
end;
$function$;

create or replace function public.review_fam_agent_idea(
  p_idea_id uuid,
  p_reviewer_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_status text;
  v_reviewer_school_id text;
begin
  if p_idea_id is null or p_reviewer_id is null or p_decision is null
     or p_decision not in ('approved', 'rejected') then
    raise exception 'Некорректное решение по предложению.'
      using errcode = '22023';
  end if;

  select p.school_id into v_reviewer_school_id
  from public.profiles as p
  where p.id = p_reviewer_id
    and p.role = 'school_admin';

  if v_reviewer_school_id is null then
    raise exception 'Решение доступно только администратору школы.'
      using errcode = '42501';
  end if;

  update private.fam_agent_ideas as i
  set status = p_decision,
      reviewed_by = p_reviewer_id,
      reviewed_at = pg_catalog.now(),
      decision_note = case
        when p_decision = 'approved' then 'Одобрено администратором FAM'
        else 'Отклонено администратором FAM'
      end,
      updated_at = pg_catalog.now()
  where i.id = p_idea_id
    and i.school_id = v_reviewer_school_id
    and i.status = 'pending'
  returning i.status into v_status;

  if v_status is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error_code', 'idea_not_pending'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', v_status
  );
end;
$function$;

revoke all on function public.get_fam_agent_admin_dashboard(text) from public, anon, authenticated;
revoke all on function public.review_fam_agent_idea(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.get_fam_agent_admin_dashboard(text) to service_role;
grant execute on function public.review_fam_agent_idea(uuid, uuid, text) to service_role;

-- Stop the earlier project-wide report job: school admins must only see their own school's metrics.
do $block$
declare
  v_old_job_id bigint;
begin
  select j.jobid into v_old_job_id
  from cron.job as j
  where j.jobname = 'fam-agent-daily-report'
  limit 1;

  if v_old_job_id is not null then
    perform cron.unschedule(v_old_job_id);
  end if;
end;
$block$;

select cron.schedule(
  'fam-agent-school-daily-report',
  '0 6 * * *',
  'select private.refresh_fam_agent_school_daily_reports();'
);

-- Populate today's school-scoped snapshot immediately so the admin UI is not empty after deployment.
select private.refresh_fam_agent_school_daily_reports();
