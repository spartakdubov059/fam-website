-- Browser telemetry uses the publishable key without a user session, so the
-- anon role is sufficient. Signed-in sessions need no direct execution access.
revoke execute on function public.report_fam_site_error(text, text)
  from authenticated;

grant execute on function public.report_fam_site_error(text, text)
  to anon;
