do $$
declare
  v_bucket timestamptz := date_trunc('hour',now());
  v_count integer;
  v_updated timestamptz;
begin
  insert into private.fam_site_error_counts(hour_bucket,event_code,page_area,event_count)
  values(v_bucket,'js_runtime','listings',998);

  if public.report_fam_site_error('js_runtime','listings') is distinct from true then
    raise exception 'valid telemetry event was rejected';
  end if;
  select event_count into v_count from private.fam_site_error_counts
    where hour_bucket=v_bucket and event_code='js_runtime' and page_area='listings';
  if v_count <> 999 then raise exception 'expected 999 after one event, got %',v_count; end if;

  perform public.report_fam_site_error('js_runtime','listings');
  select event_count into v_count from private.fam_site_error_counts
    where hour_bucket=v_bucket and event_code='js_runtime' and page_area='listings';
  if v_count <> 1000 then raise exception 'expected counter cap 1000, got %',v_count; end if;

  update private.fam_site_error_counts set updated_at='2000-01-01 00:00:00+00'
    where hour_bucket=v_bucket and event_code='js_runtime' and page_area='listings';
  perform public.report_fam_site_error('js_runtime','listings');
  select event_count,updated_at into v_count,v_updated from private.fam_site_error_counts
    where hour_bucket=v_bucket and event_code='js_runtime' and page_area='listings';
  if v_count <> 1000 then raise exception 'saturated counter changed to %',v_count; end if;
  if v_updated <> '2000-01-01 00:00:00+00'::timestamptz then
    raise exception 'saturated event caused an UPDATE';
  end if;

  if public.report_fam_site_error('unrecognized','listings') is distinct from false then
    raise exception 'invalid event code was accepted';
  end if;
  if has_function_privilege('authenticated','public.report_fam_site_error(text,text)','execute') then
    raise exception 'authenticated role unexpectedly has execute permission';
  end if;
end;
$$;
