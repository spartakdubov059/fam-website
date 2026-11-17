
begin;

-- Profiles: never expose email or role data publicly; users can read their own safe profile fields.
drop policy if exists "Profiles readable by all" on public.profiles;
drop policy if exists "public read profiles" on public.profiles;
drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "own insert profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "own update profile" on public.profiles;

revoke all on table public.profiles from anon, authenticated;
grant select (id, avatar_url, created_at, city, school_id, role) on public.profiles to authenticated;
grant update (avatar_url) on public.profiles to authenticated;

create policy "Users can read own profile"
on public.profiles for select to authenticated
using (id = (select auth.uid()));

create policy "Users can update own avatar"
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- Server-side profile creation. Role is always assigned by the database.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles (id, school_id, role)
  values (
    new.id,
    nullif(left(coalesce(new.raw_user_meta_data->>'school_id', ''), 120), ''),
    'student'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Remove the insecure self-service admin promotion RPC and its hard-coded secret.
create or replace function public.claim_admin_role(secret_code text)
returns json
language sql
security definer
set search_path = pg_catalog, public
as $$
  select json_build_object('success', false, 'error', 'Самостоятельное назначение администратора отключено');
$$;

revoke all on function public.claim_admin_role(text) from public, anon, authenticated;

-- Listings: remove permissive duplicates that allowed hidden rows to be read.
drop policy if exists "Anyone can view active listings" on public.listings;
drop policy if exists "Listings readable by all" on public.listings;
drop policy if exists "read active" on public.listings;
drop policy if exists "Users can create own listings" on public.listings;
drop policy if exists "Users can insert own listings" on public.listings;
drop policy if exists "insert own" on public.listings;
drop policy if exists "insert own listings" on public.listings;
drop policy if exists "Users can delete own listings" on public.listings;
drop policy if exists "Users can update own listings" on public.listings;
drop policy if exists "update own" on public.listings;

create policy "Read active listings or own listings"
on public.listings for select to anon, authenticated
using (status = 'active' or user_id = (select auth.uid()));

create policy "Authenticated users create own listings"
on public.listings for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "Users update own listings"
on public.listings for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "Users delete own listings"
on public.listings for delete to authenticated
using (user_id = (select auth.uid()));

-- Messages: enforce one rate-limited INSERT policy; restrict updates to read receipts only.
drop policy if exists "Rate limited messages" on public.messages;
drop policy if exists "Users can insert messages" on public.messages;
drop policy if exists "insert own" on public.messages;
drop policy if exists "insert own messages" on public.messages;
drop policy if exists "Users can read own messages" on public.messages;
drop policy if exists "Users can view own messages" on public.messages;
drop policy if exists "read own" on public.messages;
drop policy if exists "read own messages" on public.messages;
drop policy if exists "update own messages" on public.messages;

revoke all on table public.messages from anon, authenticated;
grant select, insert on public.messages to authenticated;
grant update (is_read) on public.messages to authenticated;

create policy "Conversation participants read messages"
on public.messages for select to authenticated
using (
  sender_id = (select auth.uid())
  or receiver_id = (select auth.uid())
);

create policy "Send own rate limited messages"
on public.messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and receiver_id is not null
  and receiver_id <> (select auth.uid())
  and public.can_send_message()
);

create policy "Recipients mark messages read"
on public.messages for update to authenticated
using (receiver_id = (select auth.uid()))
with check (receiver_id = (select auth.uid()));

create or replace function public.can_send_message()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  current_count integer;
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    return false;
  end if;

  insert into public.message_limits (user_id, last_sent_at, count_last_minute)
  values (current_user_id, now(), 1)
  on conflict (user_id) do update
  set count_last_minute = case
        when public.message_limits.last_sent_at > now() - interval '1 minute'
          then public.message_limits.count_last_minute + 1
        else 1
      end,
      last_sent_at = now()
  returning count_last_minute into current_count;

  return current_count <= 8;
end;
$$;

revoke all on function public.can_send_message() from public, anon;
grant execute on function public.can_send_message() to authenticated;
revoke all on table public.message_limits from anon, authenticated;

-- Ideas: only a school admin from the same school may view/manage other students' ideas.
drop policy if exists "Admins can update ideas" on public.ideas;
drop policy if exists "Admins can view school ideas" on public.ideas;
drop policy if exists "Users can delete own ideas" on public.ideas;
drop policy if exists "Users can insert own ideas" on public.ideas;
drop policy if exists "Users can view own ideas" on public.ideas;

create policy "Users read own ideas or same-school admins read"
on public.ideas for select to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'school_admin'
      and p.school_id = ideas.school_id
  )
);

create policy "Users insert own ideas"
on public.ideas for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.school_id = ideas.school_id
  )
);

create policy "Users delete own ideas"
on public.ideas for delete to authenticated
using (user_id = (select auth.uid()));

create policy "Same-school admins update ideas"
on public.ideas for update to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'school_admin'
      and p.school_id = ideas.school_id
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'school_admin'
      and p.school_id = ideas.school_id
  )
);

-- Event registrations: remove duplicate permissive policies and keep owner/participant access.
drop policy if exists "Allow secure update for event owner" on public.event_registrations;
drop policy if exists "Enable secure insert" on public.event_registrations;
drop policy if exists "Enable secure read access" on public.event_registrations;
drop policy if exists "Event creators can view registrations" on public.event_registrations;
drop policy if exists "Users can insert own registrations" on public.event_registrations;
drop policy if exists "Users can view own registrations" on public.event_registrations;

create policy "Users read own registrations or event owners read"
on public.event_registrations for select to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1 from public.listings l
    where l.id = event_registrations.event_id
      and l.user_id = (select auth.uid())
  )
);

create policy "Users create own registrations"
on public.event_registrations for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.listings l
    where l.id = event_registrations.event_id
      and l.is_event = true
      and l.status = 'active'
  )
);

create policy "Event owners update registrations"
on public.event_registrations for update to authenticated
using (
  exists (
    select 1 from public.listings l
    where l.id = event_registrations.event_id
      and l.user_id = (select auth.uid())
      and l.is_event = true
  )
)
with check (
  exists (
    select 1 from public.listings l
    where l.id = event_registrations.event_id
      and l.user_id = (select auth.uid())
      and l.is_event = true
  )
);

commit;
