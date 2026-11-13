-- Once an aggregate reaches its existing 1000-event ceiling, avoid touching it
-- on every subsequent anonymous request in the same hour.
create or replace function public.report_fam_site_error(p_event_code text,p_page_area text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_event_code is null or p_event_code not in (
    'js_runtime','unhandled_rejection','supabase_sdk_unavailable',
    'listings_load_failed','notifications_load_failed',
    'database_request_failed','auth_backend_failed'
  ) then return false; end if;
  if p_page_area is null or p_page_area not in (
    'auth','listings','notifications','database','other'
  ) then return false; end if;

  insert into private.fam_site_error_counts(hour_bucket,event_code,page_area,event_count)
  values (pg_catalog.date_trunc('hour',pg_catalog.now()),p_event_code,p_page_area,1)
  on conflict (hour_bucket,event_code,page_area)
  do update set
    event_count=least(fam_site_error_counts.event_count+1,1000),
    updated_at=pg_catalog.now()
  where fam_site_error_counts.event_count < 1000;
  return true;
end;
$function$;

revoke all on function public.report_fam_site_error(text,text) from public;
revoke execute on function public.report_fam_site_error(text,text) from authenticated;
grant execute on function public.report_fam_site_error(text,text) to anon;
