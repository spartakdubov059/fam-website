create index if not exists fam_site_error_counts_hour_idx
on private.fam_site_error_counts (hour_bucket desc,event_code,page_area);

create or replace function public.get_fam_admin_technical_alerts()
returns table (
  notification_key text,
  event_code text,
  page_area text,
  event_count integer,
  hour_bucket timestamptz,
  severity text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    'system:technical-alert:' ||
      pg_catalog.to_char(c.hour_bucket at time zone 'UTC','YYYYMMDDHH24') ||
      ':' || c.event_code || ':' || c.page_area as notification_key,
    c.event_code,
    c.page_area,
    c.event_count,
    c.hour_bucket,
    case
      when c.event_code in (
        'database_request_failed',
        'supabase_sdk_unavailable',
        'auth_backend_failed'
      ) then 'critical'
      else 'warning'
    end as severity
  from private.fam_site_error_counts as c
  where (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles as p
      where p.id = (select auth.uid())
        and p.role = 'school_admin'
    )
    and c.hour_bucket >= pg_catalog.date_trunc('hour',pg_catalog.now() - interval '24 hours')
    and c.event_count >= case c.event_code
      when 'database_request_failed' then 3
      when 'supabase_sdk_unavailable' then 3
      when 'auth_backend_failed' then 5
      when 'js_runtime' then 10
      when 'listings_load_failed' then 8
      when 'notifications_load_failed' then 8
      else 1001
    end
  order by c.hour_bucket desc,c.event_count desc
  limit 20;
$function$;

revoke all on function public.get_fam_admin_technical_alerts() from public,anon,authenticated,service_role;
grant execute on function public.get_fam_admin_technical_alerts() to authenticated;
