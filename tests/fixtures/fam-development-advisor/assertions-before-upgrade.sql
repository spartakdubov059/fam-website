do $assertions$
begin
  if pg_catalog.pg_get_function_result('public.get_fam_development_advisor_snapshots(integer)'::regprocedure)
      <> 'TABLE(report_date date, generated_at timestamp with time zone, active_listings_band text, new_listings_24h_band text)' then
    raise exception 'Expected the installed privacy-banded Advisor RPC before forward migration';
  end if;
  if has_function_privilege('anon','public.get_fam_development_advisor_snapshots(integer)','execute')
     or has_function_privilege('authenticated','public.get_fam_development_advisor_snapshots(integer)','execute')
     or not has_function_privilege('service_role','public.get_fam_development_advisor_snapshots(integer)','execute') then
    raise exception 'Original Advisor RPC grants are not service_role-only';
  end if;
end
$assertions$;
