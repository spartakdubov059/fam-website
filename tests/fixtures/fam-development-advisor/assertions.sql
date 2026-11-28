do $assertions$
begin
  if has_function_privilege('anon','public.get_fam_development_advisor_snapshots(integer)','execute')
     or has_function_privilege('authenticated','public.get_fam_development_advisor_snapshots(integer)','execute')
     or not has_function_privilege('service_role','public.get_fam_development_advisor_snapshots(integer)','execute') then
    raise exception 'Advisor RPC execute grants are not service_role-only';
  end if;
  if has_table_privilege('anon','private.fam_agent_daily_reports','select')
     or has_table_privilege('authenticated','private.fam_agent_daily_reports','select')
     or not has_table_privilege('service_role','private.fam_agent_daily_reports','select') then
    raise exception 'Aggregate source table privileges are broader than expected';
  end if;
  if pg_catalog.pg_get_function_result('public.get_fam_development_advisor_snapshots(integer)'::regprocedure)
      <> 'TABLE(report_date date, generated_at timestamp with time zone, active_listings_band text, new_listings_24h_band text)' then
    raise exception 'Advisor RPC exposes an unexpected result shape';
  end if;
end
$assertions$;

set role service_role;
do $service_role_assertions$
declare
  v_rows integer;
  v_active_banded integer;
  v_new_suppressed integer;
  v_new_5_9 integer;
  v_recent_rows integer;
begin
  select count(*), count(*) filter (where active_listings_band = '25_plus'),
    count(*) filter (where new_listings_24h_band = 'suppressed'),
    count(*) filter (where new_listings_24h_band = '5_9')
  into v_rows, v_active_banded, v_new_suppressed, v_new_5_9
  from public.get_fam_development_advisor_snapshots(7);
  if v_rows <> 7 or v_active_banded <> 7 or v_new_suppressed <> 5 or v_new_5_9 <> 2 then
    raise exception 'Unexpected seven-day synthetic aggregate bands';
  end if;
  select count(*) into v_recent_rows from public.get_fam_development_advisor_snapshots(3);
  if v_recent_rows <> 3 then
    raise exception 'Requested date window was not applied';
  end if;
  if exists(select 1 from public.get_fam_development_advisor_snapshots(2)) then
    raise exception 'Out-of-range request should return no rows';
  end if;
end
$service_role_assertions$;
reset role;


set role anon;
do $anon_access$
declare
  v_denied boolean;
begin
  v_denied := false;
  begin
    perform * from public.get_fam_development_advisor_snapshots(7);
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'anon unexpectedly executed the Advisor RPC'; end if;

  v_denied := false;
  begin
    perform count(*) from private.fam_agent_daily_reports;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'anon unexpectedly read the private aggregate source'; end if;
end
$anon_access$;
reset role;

set role authenticated;
do $authenticated_access$
declare
  v_denied boolean;
begin
  v_denied := false;
  begin
    perform * from public.get_fam_development_advisor_snapshots(7);
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'authenticated unexpectedly executed the Advisor RPC'; end if;

  v_denied := false;
  begin
    perform count(*) from private.fam_agent_daily_reports;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'authenticated unexpectedly read the private aggregate source'; end if;
end
$authenticated_access$;
reset role;

select 'PASS: Advisor RPC returns only bounded synthetic aggregates to service_role' as result;
