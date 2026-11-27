
begin;

-- The current FAM client deliberately stores ideas awaiting manual review as ai_status='pending'.
alter table public.ideas drop constraint if exists ideas_ai_status_check;
alter table public.ideas
  add constraint ideas_ai_status_check
  check (ai_status = any (array['approved'::text, 'pending'::text, 'rejected'::text]));

-- Admins may remove ideas only within their own school; ordinary users may remove only their own.
drop policy if exists "Users delete own ideas" on public.ideas;
create policy "Users or same-school admins delete ideas"
on public.ideas for delete to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'school_admin'
      and p.school_id = ideas.school_id
  )
);

-- Limit idea updates to moderation/status fields, not ownership or school assignment.
revoke update on public.ideas from anon, authenticated;
grant update (admin_status, ai_status, ai_summary, ai_reason) on public.ideas to authenticated;

-- Registration identity/event cannot be rewritten by an organizer; only status may be updated.
revoke all on public.event_registrations from anon, authenticated;
grant select, insert on public.event_registrations to authenticated;
grant update (status) on public.event_registrations to authenticated;

drop policy if exists "Users create own registrations" on public.event_registrations;
create policy "Users create own registrations"
on public.event_registrations for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.listings l
    where l.id = event_registrations.event_id
      and l.is_event = true
      and l.status = 'active'
      and l.user_id <> (select auth.uid())
      and (
        (l.event_type = 'request' and event_registrations.status = 'pending')
        or
        (coalesce(l.event_type, 'open') in ('open','limited') and event_registrations.status = 'confirmed')
      )
  )
);

commit;
