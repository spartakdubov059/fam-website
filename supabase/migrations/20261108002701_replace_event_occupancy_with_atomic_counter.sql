
begin;

-- Replace the privileged aggregate view with a small, row-secured counter table.
drop view if exists public.event_occupancy;

create table public.event_occupancy (
  event_id uuid primary key references public.listings(id) on delete cascade,
  taken integer not null default 0 check (taken >= 0)
);

alter table public.event_occupancy enable row level security;
revoke all on table public.event_occupancy from public, anon, authenticated;
grant select on table public.event_occupancy to anon, authenticated;

create policy "Anyone can read event occupancy counts"
on public.event_occupancy
for select to anon, authenticated
using (true);

-- Backfill counts without exposing registration identities.
insert into public.event_occupancy (event_id, taken)
select event_id, count(*)::integer
from public.event_registrations
where status in ('pending', 'confirmed')
  and event_id is not null
group by event_id;

-- Prevent duplicate registrations even if two requests arrive at the same time.
create unique index if not exists event_registrations_event_user_unique
on public.event_registrations(event_id, user_id)
where event_id is not null and user_id is not null;

-- The reservation itself is serialized by an atomic counter-row upsert.
create or replace function private.reserve_event_seat()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_is_event boolean;
  v_listing_status text;
  v_event_type text;
  v_max_seats integer;
  v_limit integer;
  v_taken integer;
  v_old_reserved boolean := false;
  v_new_reserved boolean := false;
begin
  if tg_op = 'UPDATE' then
    if new.event_id is distinct from old.event_id
       or new.user_id is distinct from old.user_id then
      raise exception 'Registration identity cannot be changed';
    end if;

    if old.status <> 'pending'
       or new.status not in ('pending', 'confirmed', 'rejected') then
      if new.status is distinct from old.status then
        raise exception 'Only pending registrations can be processed';
      end if;
    end if;

    v_old_reserved := old.status in ('pending', 'confirmed');
  end if;

  if new.status not in ('pending', 'confirmed') then
    if tg_op = 'INSERT' then
      raise exception 'New registrations must reserve a seat';
    end if;
  end if;

  v_new_reserved := new.status in ('pending', 'confirmed');

  select l.is_event, l.status, l.event_type, coalesce(l.max_seats, 0)
    into v_is_event, v_listing_status, v_event_type, v_max_seats
  from public.listings l
  where l.id = new.event_id
  for update;

  if not found or v_is_event is not true or v_listing_status <> 'active' then
    raise exception 'Event is not available for registration';
  end if;

  if tg_op = 'INSERT' then
    if v_event_type = 'request' and new.status <> 'pending' then
      raise exception 'This event requires organizer approval';
    end if;
    if coalesce(v_event_type, 'open') in ('open', 'limited') and new.status <> 'confirmed' then
      raise exception 'Invalid registration status for this event';
    end if;
  end if;

  -- Zero means unlimited, matching the existing FAM interface.
  v_limit := case when v_event_type = 'limited' then v_max_seats else 0 end;

  if v_new_reserved and not v_old_reserved then
    insert into public.event_occupancy (event_id, taken)
    values (new.event_id, 1)
    on conflict (event_id) do update
      set taken = public.event_occupancy.taken + 1
      where v_limit <= 0 or public.event_occupancy.taken < v_limit
    returning taken into v_taken;

    if not found then
      raise exception 'NO_SEATS_AVAILABLE';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.release_event_seat()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('pending', 'confirmed') then
      update public.event_occupancy
        set taken = greatest(taken - 1, 0)
      where event_id = old.event_id;
    end if;
    return old;
  end if;

  if old.status in ('pending', 'confirmed')
     and new.status not in ('pending', 'confirmed') then
    update public.event_occupancy
      set taken = greatest(taken - 1, 0)
    where event_id = old.event_id;
  end if;
  return new;
end;
$$;

revoke all on function private.reserve_event_seat() from public, anon, authenticated;
revoke all on function private.release_event_seat() from public, anon, authenticated;

drop trigger if exists reserve_event_seat_before_write on public.event_registrations;
create trigger reserve_event_seat_before_write
before insert or update of event_id, status, user_id
on public.event_registrations
for each row execute function private.reserve_event_seat();

drop trigger if exists release_event_seat_after_write on public.event_registrations;
create trigger release_event_seat_after_write
after update of status or delete
on public.event_registrations
for each row execute function private.release_event_seat();

-- Close unused internal tables at the Data API boundary.
revoke all on table public.events from public, anon, authenticated;
revoke all on table public.school_accounts from public, anon, authenticated;
revoke all on table public.message_limits from public, anon, authenticated;

-- Keep the event-registration insert policy aligned with the database trigger.
drop policy if exists "Users create own registrations" on public.event_registrations;
create policy "Users create own registrations"
on public.event_registrations for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.listings l
    where l.id = event_registrations.event_id
      and l.is_event = true
      and l.status = 'active'
      and l.user_id <> (select auth.uid())
      and (
        (l.event_type = 'request' and event_registrations.status = 'pending')
        or
        (coalesce(l.event_type, 'open') in ('open', 'limited') and event_registrations.status = 'confirmed')
      )
  )
);

commit;
