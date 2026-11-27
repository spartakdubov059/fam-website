do $assertions$
begin
  if has_function_privilege('anon','public.get_fam_moderation_aggregate_summary()','execute')
     or has_function_privilege('authenticated','public.get_fam_moderation_aggregate_summary()','execute')
     or not has_function_privilege('service_role','public.get_fam_moderation_aggregate_summary()','execute') then
    raise exception 'Moderator RPC execute grants are not service_role-only';
  end if;
  if has_table_privilege('anon','public.fam_safety_incidents','select')
     or has_table_privilege('authenticated','public.fam_safety_incidents','select')
     or not has_table_privilege('service_role','public.fam_safety_incidents','select') then
    raise exception 'Moderation source table privileges are broader than expected';
  end if;
  if pg_catalog.pg_get_function_result('public.get_fam_moderation_aggregate_summary()'::regprocedure)
      <> 'TABLE(generated_at timestamp with time zone, total_bucket text, categories jsonb)' then
    raise exception 'Moderator RPC exposes an unexpected result shape';
  end if;
end
$assertions$;

set role service_role;
do $service_role_assertions$
declare
  v_rows integer;
  v_generated_at timestamptz;
  v_total_bucket text;
  v_categories jsonb;
begin
  select count(*) into v_rows
  from public.get_fam_moderation_aggregate_summary();
  select generated_at, total_bucket, categories
  into v_generated_at, v_total_bucket, v_categories
  from public.get_fam_moderation_aggregate_summary();

  if v_rows <> 1 or v_generated_at is null or v_total_bucket <> '5_9' then
    raise exception 'Unexpected synthetic moderator summary: rows %, bucket %', v_rows, v_total_bucket;
  end if;
  if v_categories is null or pg_catalog.jsonb_array_length(v_categories) <> 1 then
    raise exception 'A category affecting fewer than five schools was exposed';
  end if;
  if (v_categories -> 0) <> '{"category":"targeted_harassment","severity":"medium","count_bucket":"5_9"}'::jsonb then
    raise exception 'Unexpected category aggregate shape or bucket: %', v_categories;
  end if;
  if v_categories::text ~* '(school_id|actor_id|target_id|pair_fingerprint|evidence_excerpt|source_origin|small-school|synthetic personal-data)' then
    raise exception 'Moderator summary contains identifiers or content';
  end if;
end
$service_role_assertions$;
reset role;

delete from public.fam_safety_incidents;
insert into public.fam_safety_incidents
  (id, school_id, pair_fingerprint, source_kind, category, severity)
select
  pg_catalog.md5('suppressed-' || n)::uuid,
  'suppressed-school-' || n::text,
  pg_catalog.repeat('c', 64),
  'message',
  'threat_or_intimidation',
  'high'
from pg_catalog.generate_series(1, 4) as s(n);

set role service_role;
do $suppression_assertions$
declare
  v_total_bucket text;
  v_categories jsonb;
begin
  select total_bucket, categories
  into v_total_bucket, v_categories
  from public.get_fam_moderation_aggregate_summary();
  if v_total_bucket <> 'suppressed' or v_categories <> '[]'::jsonb then
    raise exception 'Signals from fewer than five schools were not suppressed';
  end if;
end
$suppression_assertions$;
reset role;

delete from public.fam_safety_incidents;
set role service_role;
do $empty_assertions$
declare
  v_total_bucket text;
  v_categories jsonb;
begin
  select total_bucket, categories
  into v_total_bucket, v_categories
  from public.get_fam_moderation_aggregate_summary();
  if v_total_bucket <> 'none' or v_categories <> '[]'::jsonb then
    raise exception 'Empty aggregate was not reported as no signal';
  end if;
end
$empty_assertions$;
reset role;

set role anon;
do $anon_access$
declare v_denied boolean := false;
begin
  begin
    perform * from public.get_fam_moderation_aggregate_summary();
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'anon unexpectedly executed moderator RPC'; end if;
  v_denied := false;
  begin
    perform count(*) from public.fam_safety_incidents;
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'anon unexpectedly read moderation source'; end if;
end
$anon_access$;
reset role;

set role authenticated;
do $authenticated_access$
declare v_denied boolean := false;
begin
  begin
    perform * from public.get_fam_moderation_aggregate_summary();
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'authenticated unexpectedly executed moderator RPC'; end if;
  v_denied := false;
  begin
    perform count(*) from public.fam_safety_incidents;
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'authenticated unexpectedly read moderation source'; end if;
end
$authenticated_access$;
reset role;

select 'PASS: protected moderator summary contains only thresholded synthetic aggregates' as result;
