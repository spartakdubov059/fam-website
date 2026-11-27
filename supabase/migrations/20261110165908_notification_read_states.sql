create table if not exists public.notification_reads (
  user_id uuid not null references auth.users (id) on delete cascade,
  notification_key text not null
    check (char_length(notification_key) between 1 and 220),
  read_at timestamptz not null default now(),
  primary key (user_id, notification_key)
);

comment on table public.notification_reads is
  'Persistent per-account read state for FAM notifications; each user can access only their own rows.';

alter table public.notification_reads enable row level security;

revoke all on table public.notification_reads from public, anon, authenticated, service_role;
grant select, insert, update on table public.notification_reads to authenticated;
grant all on table public.notification_reads to service_role;

drop policy if exists "Users can read their own FAM notification states" on public.notification_reads;
create policy "Users can read their own FAM notification states"
  on public.notification_reads
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own FAM notification states" on public.notification_reads;
create policy "Users can insert their own FAM notification states"
  on public.notification_reads
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own FAM notification states" on public.notification_reads;
create policy "Users can update their own FAM notification states"
  on public.notification_reads
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
