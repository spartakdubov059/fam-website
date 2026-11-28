-- Durable, metadata-only observation journal for LEGAL.
-- It records source checks, never legal conclusions, student data, or source text.
begin;

create schema if not exists private;

create table private.fam_legal_evidence_archive (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('FAM_CURRENT', 'FAM_RU')),
  revision text not null check (revision ~ '^[0-9a-fA-F]{40}$'),
  criterion_id text not null check (criterion_id in (
    'official_source_review',
    'scope_applicability_review',
    'student_data_minimization_review',
    'access_control_review',
    'qualified_counsel_review'
  )),
  source_id text not null check (source_id in (
    'official_portal_all',
    'official_portal_president',
    'official_portal_government',
    'official_portal_council_1',
    'official_portal_council_2',
    'official_portal_federal_authorities',
    'official_portal_court',
    'official_portal_international'
  )),
  source_url text not null check (
    char_length(source_url) <= 500
    and source_url ~ '^https://(publication\.pravo\.gov\.ru|pravo\.gov\.ru)(/[^?#]*)?$'
  ),
  status text not null check (status in ('source_checked', 'change_detected', 'source_unavailable')),
  document_id text not null default '' check (document_id = '' or document_id ~ '^[0-9]{10,20}$'),
  document_sha256 text not null default '' check (document_sha256 = '' or document_sha256 ~ '^[0-9a-f]{64}$'),
  priority text not null default 'unassessed' check (priority = 'unassessed'),
  previous_record_id uuid references private.fam_legal_evidence_archive(id),
  previous_record_sha256 text not null default '' check (previous_record_sha256 = '' or previous_record_sha256 ~ '^[0-9a-f]{64}$'),
  record_sha256 text not null check (record_sha256 ~ '^[0-9a-f]{64}$'),
  decision text not null default 'pending_human_review'
    check (decision = 'pending_human_review'),
  checked_at timestamptz not null default clock_timestamp(),
  checked_day date not null default ((clock_timestamp() at time zone 'UTC')::date),
  check (
    (status = 'source_unavailable' and document_id = '' and document_sha256 = '')
    or
    (status in ('source_checked', 'change_detected') and document_id <> '' and document_sha256 <> '')
  )
);

alter table private.fam_legal_evidence_archive enable row level security;
alter table private.fam_legal_evidence_archive force row level security;

grant usage on schema private to service_role;
revoke all on table private.fam_legal_evidence_archive from public, anon, authenticated, service_role;
grant select on table private.fam_legal_evidence_archive to service_role;

create unique index fam_legal_evidence_archive_daily_observation_idx
  on private.fam_legal_evidence_archive (
    scope, revision, criterion_id, source_id, status, document_id, document_sha256, checked_day
  );

create unique index fam_legal_evidence_archive_change_once_idx
  on private.fam_legal_evidence_archive (scope, source_id, document_id, document_sha256)
  where status = 'change_detected';

create or replace function private.reject_fam_legal_evidence_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'FAM legal evidence archive is append-only' using errcode = '55000';
end;
$function$;

revoke all on function private.reject_fam_legal_evidence_mutation() from public, anon, authenticated, service_role;

create trigger fam_legal_evidence_archive_no_update_delete
  before update or delete on private.fam_legal_evidence_archive
  for each row execute function private.reject_fam_legal_evidence_mutation();

create or replace function public.append_fam_legal_evidence_observation(
  p_scope text,
  p_revision text,
  p_criterion_id text,
  p_source_id text,
  p_source_url text,
  p_status text,
  p_document_id text default null,
  p_document_sha256 text default null
)
returns table(record_id uuid, inserted boolean, status text, decision text)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_document_id text := coalesce(p_document_id, '');
  v_document_sha256 text := coalesce(p_document_sha256, '');
  v_checked_at timestamptz := pg_catalog.clock_timestamp();
  v_checked_day date := (v_checked_at at time zone 'UTC')::date;
  v_record_id uuid;
  v_previous_record_id uuid;
  v_previous_record_sha256 text := '';
  v_record_sha256 text;
begin
  if coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''), '') <> 'service_role' then
    raise exception 'LEGAL archive requires the protected service role' using errcode = '42501';
  end if;
  if p_scope not in ('FAM_CURRENT', 'FAM_RU')
     or p_revision !~ '^[0-9a-fA-F]{40}$'
     or p_criterion_id not in (
       'official_source_review', 'scope_applicability_review',
       'student_data_minimization_review', 'access_control_review', 'qualified_counsel_review'
     )
     or p_source_id not in (
       'official_portal_all', 'official_portal_president', 'official_portal_government',
       'official_portal_council_1', 'official_portal_council_2',
       'official_portal_federal_authorities', 'official_portal_court', 'official_portal_international'
     )
     or p_source_url is null
     or char_length(p_source_url) > 500
     or p_source_url !~ '^https://(publication\.pravo\.gov\.ru|pravo\.gov\.ru)(/[^?#]*)?$'
     or p_status not in ('source_checked', 'change_detected', 'source_unavailable')
     or v_document_id !~ '^([0-9]{10,20})?$'
     or v_document_sha256 !~ '^([0-9a-f]{64})?$'
     or ((p_status = 'source_unavailable') and (v_document_id <> '' or v_document_sha256 <> ''))
     or ((p_status in ('source_checked', 'change_detected')) and (v_document_id = '' or v_document_sha256 = '')) then
    raise exception 'LEGAL source observation is outside the fixed archive contract' using errcode = '22023';
  end if;

  -- Serialize each scope so concurrent observations form one verifiable chain.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_scope, 781943));

  select archive.id, archive.record_sha256
    into v_previous_record_id, v_previous_record_sha256
  from private.fam_legal_evidence_archive as archive
  where archive.scope = p_scope
  order by archive.checked_at desc, archive.id desc
  limit 1;
  v_previous_record_sha256 := coalesce(v_previous_record_sha256, '');
  v_record_sha256 := encode(extensions.digest(convert_to(
    jsonb_build_object(
      'scope', p_scope, 'revision', p_revision, 'criterion_id', p_criterion_id,
      'source_id', p_source_id, 'source_url', p_source_url, 'status', p_status,
      'document_id', v_document_id, 'document_sha256', v_document_sha256,
      'priority', 'unassessed', 'previous_record_id', v_previous_record_id,
      'previous_record_sha256', v_previous_record_sha256,
      'decision', 'pending_human_review',
      'checked_at', pg_catalog.to_char(v_checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'checked_day', v_checked_day
    )::text, 'UTF8'), 'sha256'), 'hex');

  insert into private.fam_legal_evidence_archive as archive (
    scope, revision, criterion_id, source_id, source_url, status,
    document_id, document_sha256, priority, previous_record_id,
    previous_record_sha256, record_sha256, decision, checked_at, checked_day
  ) values (
    p_scope, p_revision, p_criterion_id, p_source_id, p_source_url, p_status,
    v_document_id, v_document_sha256, 'unassessed', v_previous_record_id,
    v_previous_record_sha256, v_record_sha256, 'pending_human_review', v_checked_at, v_checked_day
  )
  on conflict do nothing
  returning archive.id into v_record_id;

  if v_record_id is not null then
    return query select v_record_id, true, p_status, 'pending_human_review'::text;
    return;
  end if;

  select archive.id into v_record_id
  from private.fam_legal_evidence_archive as archive
  where (
      archive.scope = p_scope
      and archive.revision = p_revision
      and archive.criterion_id = p_criterion_id
      and archive.source_id = p_source_id
      and archive.status = p_status
      and archive.document_id = v_document_id
      and archive.document_sha256 = v_document_sha256
      and archive.checked_day = v_checked_day
    ) or (
      p_status = 'change_detected'
      and archive.scope = p_scope
      and archive.source_id = p_source_id
      and archive.document_id = v_document_id
      and archive.document_sha256 = v_document_sha256
      and archive.status = 'change_detected'
    )
  order by archive.checked_at desc
  limit 1;

  if v_record_id is null then
    raise exception 'LEGAL archive idempotency lookup failed' using errcode = '40001';
  end if;
  return query select v_record_id, false, p_status, 'pending_human_review'::text;
end;
$function$;

alter function public.append_fam_legal_evidence_observation(text, text, text, text, text, text, text, text)
  owner to postgres;

revoke all on function public.append_fam_legal_evidence_observation(text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.append_fam_legal_evidence_observation(text, text, text, text, text, text, text, text)
  to service_role;

create or replace function public.get_fam_legal_evidence_summary()
returns table(scope text, latest_checked_at timestamptz, latest_status text, observations_30d bigint)
language sql
stable
security invoker
set search_path = ''
as $function$
  with scopes(scope) as (
    values ('FAM_CURRENT'::text), ('FAM_RU'::text)
  ), recent as (
    select a.scope, a.checked_at, a.status
    from private.fam_legal_evidence_archive as a
    where a.checked_at >= pg_catalog.now() - interval '30 days'
  ), latest as (
    select distinct on (r.scope) r.scope, r.checked_at, r.status
    from recent as r
    order by r.scope, r.checked_at desc, r.status
  ), counts as (
    select r.scope, pg_catalog.count(*)::bigint as observations
    from recent as r
    group by r.scope
  )
  select s.scope, l.checked_at,
    coalesce(l.status, 'not_assessed'),
    coalesce(c.observations, 0::bigint)
  from scopes as s
  left join latest as l on l.scope = s.scope
  left join counts as c on c.scope = s.scope
  order by s.scope;
$function$;

revoke all on function public.get_fam_legal_evidence_summary() from public, anon, authenticated;
grant execute on function public.get_fam_legal_evidence_summary() to service_role;

comment on table private.fam_legal_evidence_archive is
  'Append-only metadata for official-source checks with a per-scope SHA-256 chain. Priority remains unassessed; no source text, student data, legal conclusions, or release approvals.';
comment on function public.get_fam_legal_evidence_summary() is
  'Returns only per-scope source-check freshness and status. Every observation remains pending human review and is not a legal readiness decision.';

commit;
