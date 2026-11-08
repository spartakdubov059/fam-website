
begin;

drop policy if exists "Deny client access to internal events" on public.events;
create policy "Deny client access to internal events"
on public.events for all to anon, authenticated
using (false) with check (false);

drop policy if exists "Deny client access to school accounts" on public.school_accounts;
create policy "Deny client access to school accounts"
on public.school_accounts for all to anon, authenticated
using (false) with check (false);

drop policy if exists "Deny client access to message counters" on public.message_limits;
create policy "Deny client access to message counters"
on public.message_limits for all to anon, authenticated
using (false) with check (false);

commit;
