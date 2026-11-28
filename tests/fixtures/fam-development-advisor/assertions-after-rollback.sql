do $rollback_contract$
declare
  v_active_band text;
  v_new_band text;
begin
  if pg_catalog.pg_get_function_result('public.get_fam_development_advisor_snapshots(integer)'::regprocedure)
      <> 'TABLE(report_date date, generated_at timestamp with time zone, active_listings_band text, new_listings_24h_band text)' then
    raise exception 'Rollback did not preserve the privacy-banded listing contract';
  end if;
  select active_listings_band, new_listings_24h_band
    into v_active_band, v_new_band
  from public.get_fam_development_advisor_snapshots(7)
  order by report_date desc limit 1;
  if v_active_band <> '25_plus' or v_new_band <> 'none' then
    raise exception 'Rollback returned an unexpected or unbanded synthetic result';
  end if;
end
$rollback_contract$;

select 'PASS: rollback retained bounded listing bands' as result;
