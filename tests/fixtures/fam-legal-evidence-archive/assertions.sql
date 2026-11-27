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
     has_table_privilege('service_role', 'private.fam_legal_evidence_archive', 'TRUNCATE') then
    raise exception 'service_role must not mutate or truncate the archive directly';
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
do $$
declare
  v_first record;
  v_second record;
  v_summary record;
  v_failed boolean := false;
begin
  select * into v_first from public.append_fam_legal_evidence_observation(
    'FAM_CURRENT', repeat('a', 40), 'official_source_review', 'official_portal_government',
    'https://publication.pravo.gov.ru/document/0001202611270001', 'change_detected',
    '0001202611270001', repeat('b', 64));
  if v_first.inserted is distinct from true or v_first.decision <> 'pending_human_review' then
    raise exception 'first observation was not stored as pending human review';
  end if;

  select * into v_second from public.append_fam_legal_evidence_observation(
    'FAM_CURRENT', repeat('a', 40), 'official_source_review', 'official_portal_government',
    'https://publication.pravo.gov.ru/document/0001202611270001', 'change_detected',
    '0001202611270001', repeat('b', 64));
  if v_second.inserted is distinct from false or v_second.record_id <> v_first.record_id then
    raise exception 'duplicate observation was not idempotent';
  end if;

  select * into v_second from public.append_fam_legal_evidence_observation(
    'FAM_CURRENT', repeat('c', 40), 'official_source_review', 'official_portal_government',
    'https://publication.pravo.gov.ru/document/0001202611270001', 'change_detected',
    '0001202611270001', repeat('b', 64));
  if v_second.inserted is distinct from false or v_second.record_id <> v_first.record_id then
    raise exception 'same change was duplicated across a new code revision';
  end if;

  select * into v_summary from public.get_fam_legal_evidence_summary() where scope = 'FAM_CURRENT';
  if v_summary.latest_status <> 'change_detected' or v_summary.observations_30d <> 1 then
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
