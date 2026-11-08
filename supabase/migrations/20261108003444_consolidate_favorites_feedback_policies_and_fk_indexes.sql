
begin;

-- Favorites: a single authenticated owner policy instead of four overlapping policies.
drop policy if exists "delete own" on public.favorites;
drop policy if exists "insert own" on public.favorites;
drop policy if exists "own favorites" on public.favorites;
drop policy if exists "read own" on public.favorites;

revoke all on table public.favorites from public, anon, authenticated;
grant select, insert, delete on table public.favorites to authenticated;

create policy "Users manage only their own favorites"
on public.favorites for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create unique index if not exists favorites_user_listing_unique
on public.favorites(user_id, listing_id)
where user_id is not null and listing_id is not null;

-- Feedback: retain public aggregate/review display, but never expose the author UUID.
drop policy if exists "Feedbacks readable by all" on public.feedbacks;
drop policy if exists "Users can read feedback" on public.feedbacks;
drop policy if exists "Users can insert feedback" on public.feedbacks;
drop policy if exists "Users can insert own feedback" on public.feedbacks;

revoke all on table public.feedbacks from public, anon, authenticated;
grant select (id, event_id, stars, text, created_at) on public.feedbacks to anon, authenticated;
grant insert (event_id, user_id, stars, text) on public.feedbacks to authenticated;

create policy "Public can read feedback without author identity"
on public.feedbacks for select to anon, authenticated
using (true);

create policy "Authenticated users submit own feedback"
on public.feedbacks for insert to authenticated
with check (user_id = (select auth.uid()));

-- Cover the foreign keys reported by the Supabase performance advisor.
create index if not exists event_registrations_user_id_idx
  on public.event_registrations(user_id);
create index if not exists events_organizer_id_idx
  on public.events(organizer_id);
create index if not exists favorites_listing_id_idx
  on public.favorites(listing_id);
create index if not exists feedbacks_user_id_idx
  on public.feedbacks(user_id);
create index if not exists ideas_user_id_idx
  on public.ideas(user_id);
create index if not exists listings_user_id_idx
  on public.listings(user_id);
create index if not exists messages_listing_id_idx
  on public.messages(listing_id);
create index if not exists messages_receiver_id_idx
  on public.messages(receiver_id);

commit;
