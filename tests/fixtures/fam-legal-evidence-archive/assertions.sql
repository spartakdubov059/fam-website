\set ON_ERROR_STOP on
do $$
declare
  v_enabled boolean;
  v_forced boolean;
begin
  select c.relrowsecurity, c.relforcerowsecurity into v_enabled, v_forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private' and c.relname = 'fam_legal_evidence_archive';
  if v_enabled is distinct from true or v_forced is distinct from true then
    raise exception 'archive table must enforce RLS';
  end if;
  if not has_schema_privilege('authenticated', 'private', 'USAGE') then
    raise exception 'migration unexpectedly changed shared private schema grants';
  end if;
  if has_table_privilege('authenticated', 'private.fam_legal_evidence_archive', 'SELECT') or
     has_table_privilege('authenticated', 'private.fam_legal_evidence_archive', 'INSERT') then
    raise exception 'authenticated must not access legal archive';
  end if;
  if has_table_privilege('service_role', 'private.fam_legal_evidence_archive', 'UPDATE') or
     has_table_privilege('service_role', 'private.fam_legal_evidence_archive', 'DELETE') or
     has_table_privilege('service_role', 'private.fam_legal_evidence_archive', 'TRUNCATE') or
     has_table_privilege('service_role', 'private.fam_legal_evidence_archive', 'INSERT') then
    raise exception 'service_role must not mutate or truncate the archive directly';
  end if;
  if not (select prosecdef from pg_catalog.pg_proc where oid =
      'public.append_fam_legal_evidence_observation(text,text,text,text,text,text,text,text)'::regprocedure) or
     (select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc where oid =
      'public.append_fam_legal_evidence_observation(text,text,text,text,text,text,text,text)'::regprocedure) <> 'postgres' then
    raise exception 'append RPC must execute as its fixed protected owner';
  end if;
  if not has_function_privilege('service_role', 'public.append_fam_legal_evidence_observation(text,text,text,text,text,text,text,text)', 'EXECUTE') or
     has_function_privilege('authenticated', 'public.append_fam_legal_evidence_observation(text,text,text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'append RPC grants are incorrect';
  end if;
  if not has_function_privilege('service_role', 'public.get_fam_legal_evidence_summary()', 'EXECUTE') or
     has_function_privilege('anon', 'public.get_fam_legal_evidence_summary()', 'EXECUTE') then
    raise exception 'summary RPC grants are incorrect';
  end if;
end $$;

begin;
set role service_role;
set local request.jwt.claim.role = 'service_role';
do $$
declare v_denied boolean := false;
begin
  begin
    insert into private.fam_legal_evidence_archive (
      scope, revision, criterion_id, source_id, source_url, status,
      document_id, document_sha256, record_sha256
    ) values (
      'FAM_CURRENT', repeat('a', 40), 'official_source_review', 'official_portal_all',
      'https://publication.pravo.gov.ru/', 'source_checked', repeat('1', 12),
      repeat('a', 64), repeat('0', 64)
    );
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'Direct archive insert unexpectedly succeeded'; end if;
end $$;
set local request.jwt.claim.role = '';
do $$
declare v_denied boolean := false;
begin
  begin
    perform * from public.append_fam_legal_evidence_observation(
      'FAM_CURRENT', repeat('a', 40), 'official_source_review', 'official_portal_all',
      'https://publication.pravo.gov.ru/', 'source_unavailable', null, null
    );
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'RPC accepted service_role without a service-role JWT claim'; end if;
end $$;
set local request.jwt.claim.role = 'service_role';
do $$
declare
  v_first record;
  v_second record;
  v_summary record;
  v_second_scope record;
  v_ru record;
  v_chain_ok boolean;
  v_failed boolean := false;
begin
  select * into v_first from public.append_fam_legal_evidence_observation(
    'FAM_CURRENT', repeat('a', 40), 'official_source_review', 'official_portal_government',
    'https://publication.pravo.gov.ru/document/0001202611270001', 'change_detected',
    '0001202611270001', repeat('b', 64));
  if v_first.inserted is distinct from true or v_first.decision <> 'pending_human_review' then
    raise exception 'first observation was not stored as pending human review';
  end if;
  if not exists (
    select 1 from private.fam_legal_evidence_archive a
    where a.id = v_first.record_id and a.priority = 'unassessed'
      and a.previous_record_id is null and a.previous_record_sha256 = ''
      and a.record_sha256 = encode(extensions.digest(convert_to(jsonb_build_object(
        'scope', a.scope, 'revision', a.revision, 'criterion_id', a.criterion_id,
        'source_id', a.source_id, 'source_url', a.source_url, 'status', a.status,
        'document_id', a.document_id, 'document_sha256', a.document_sha256,
        'priority', a.priority, 'previous_record_id', a.previous_record_id,
        'previous_record_sha256', a.previous_record_sha256, 'decision', a.decision,
        'checked_at', to_char(a.checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'checked_day', a.checked_day
      )::text, 'UTF8'), 'sha256'), 'hex')
  ) then raise exception 'first archive record hash/priority contract failed'; end if;

  select * into v_second from public.append_fam_legal_evidence_observation(
    'FAM_CURRENT', repeat('a', 40), 'official_source_review', 'official_portal_government',
    'https://publication.pravo.gov.ru/document/0001202611270001', 'change_detected',
    '0001202611270001', repeat('b', 64));
  if v_second.inserted is distinct from false or v_second.record_id <> v_first.record_id then
    raise exception 'duplicate observation was not idempotent';
  end if;

  select * into v_second_scope from public.append_fam_legal_evidence_observation(
    'FAM_CURRENT', repeat('c', 40), 'access_control_review', 'official_portal_court',
    'https://pravo.gov.ru/document/0001202611270003', 'source_unavailable', null, null);
  select exists (
    select 1 from private.fam_legal_evidence_archive current_record
    join private.fam_legal_evidence_archive previous_record
      on previous_record.id = current_record.previous_record_id
    where current_record.id = v_second_scope.record_id
      and previous_record.id = v_first.record_id
      and current_record.previous_record_sha256 = previous_record.record_sha256
      and current_record.priority = 'unassessed'
      and current_record.record_sha256 = encode(extensions.digest(convert_to(jsonb_build_object(
        'scope', current_record.scope, 'revision', current_record.revision,
        'criterion_id', current_record.criterion_id, 'source_id', current_record.source_id,
        'source_url', current_record.source_url, 'status', current_record.status,
        'document_id', current_record.document_id, 'document_sha256', current_record.document_sha256,
        'priority', current_record.priority, 'previous_record_id', current_record.previous_record_id,
        'previous_record_sha256', current_record.previous_record_sha256,
        'decision', current_record.decision,
        'checked_at', to_char(current_record.checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'checked_day', current_record.checked_day
      )::text, 'UTF8'), 'sha256'), 'hex')
  ) into v_chain_ok;
  if not v_chain_ok then raise exception 'archive chain link or hash verification failed'; end if;

  select * into v_ru from public.append_fam_legal_evidence_observation(
    'FAM_RU', repeat('d', 40), 'official_source_review', 'official_portal_government',
    'https://publication.pravo.gov.ru', 'source_unavailable', null, null);
  if not exists (
    select 1 from private.fam_legal_evidence_archive ru_record
    where ru_record.id = v_ru.record_id and ru_record.scope = 'FAM_RU'
      and ru_record.previous_record_id is null and ru_record.previous_record_sha256 = ''
      and ru_record.priority = 'unassessed'
      and ru_record.decision = 'pending_human_review'
  ) then raise exception 'FAM_RU archive chain was not isolated from FAM_CURRENT'; end if;

  select * into v_second from public.append_fam_legal_evidence_observation(
    'FAM_CURRENT', repeat('c', 40), 'official_source_review', 'official_portal_government',
    'https://publication.pravo.gov.ru/document/0001202611270001', 'change_detected',
    '0001202611270001', repeat('b', 64));
  if v_second.inserted is distinct from false or v_second.record_id <> v_first.record_id then
    raise exception 'same change was duplicated across a new code revision';
  end if;

  select * into v_summary from public.get_fam_legal_evidence_summary() where scope = 'FAM_CURRENT';
  if v_summary.latest_status <> 'source_unavailable' or v_summary.observations_30d <> 2 then
    raise exception 'summary did not report the stored synthetic observation';
  end if;

  begin
    perform * from public.append_fam_legal_evidence_observation(
      'FAM_CURRENT', repeat('a', 40), 'official_source_review', 'official_portal_government',
      'http://publication.pravo.gov.ru/document/0001202611270002', 'source_checked',
      '0001202611270002', repeat('c', 64));
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'non-HTTPS source URL was accepted'; end if;

end $$;
reset role;

do $$
declare
  v_failed boolean := false;
begin
  begin
    update private.fam_legal_evidence_archive set decision = 'confirmed';
  exception when sqlstate '55000' then v_failed := true;
  end;
  if not v_failed then raise exception 'archive row update was accepted'; end if;

  v_failed := false;
  begin
    delete from private.fam_legal_evidence_archive;
  exception when sqlstate '55000' then v_failed := true;
  end;
  if not v_failed then raise exception 'archive row deletion was accepted'; end if;
end $$;
rollback;
