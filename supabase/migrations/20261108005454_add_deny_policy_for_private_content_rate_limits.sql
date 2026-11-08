
begin;
drop policy if exists "Deny client access to content rate limits" on private.content_rate_limits;
create policy "Deny client access to content rate limits"
on private.content_rate_limits
for all to public
using (false)
with check (false);
commit;
