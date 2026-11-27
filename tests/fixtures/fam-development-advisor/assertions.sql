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
      <> 'TABLE(report_date date, generated_at timestamp with time zone, active_listings integer, new_listings_24h integer)' then
    raise exception 'Advisor RPC exposes an unexpected result shape';
  end if;
end
$assertions$;

set role service_role;
do $service_role_assertions$
declare
  v_rows integer;
  v_active integer;
  v_new integer;
  v_recent_rows integer;
begin
  select count(*), sum(active_listings), sum(new_listings_24h)
  into v_rows, v_active, v_new
  from public.get_fam_development_advisor_snapshots(7);
  if v_rows <> 7 or v_active <> 259 or v_new <> 21 then
    raise exception 'Unexpected seven-day synthetic aggregates: %, %, %',v_rows,v_active,v_new;
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

select 'PASS: Advisor RPC returns only bounded synthetic aggregates to service_role' as result;
