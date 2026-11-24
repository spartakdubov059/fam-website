-- FAM server-side chat isolation. User registration metadata must not be
-- trusted as proof of a school, but every message must still respect the
-- existing profile school boundary and the listing conversation ownership.
-- Service-role writes bypass RLS; this trigger also checks those writes.
create or replace function private.fam_guard_message_school()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sender_school text;
  recipient_school text;
begin
  select p.school_id into sender_school
  from public.profiles p where p.id = new.sender_id;
  select p.school_id into recipient_school
  from public.profiles p where p.id = new.receiver_id;

  if sender_school is null or recipient_school is null
     or sender_school is distinct from recipient_school
     or new.sender_id = new.receiver_id then
    raise exception 'message_school_mismatch' using errcode = '23514';
  end if;

  if new.listing_id is not null and not exists (
    select 1 from public.listings l
    where l.id = new.listing_id
      and l.school_id = sender_school
      and l.user_id in (new.sender_id, new.receiver_id)
  ) then
    raise exception 'message_listing_mismatch' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.fam_guard_message_school()
from public, anon, authenticated;

drop trigger if exists fam_guard_message_school_before_insert on public.messages;
create trigger fam_guard_message_school_before_insert
before insert on public.messages
for each row
execute function private.fam_guard_message_school();
