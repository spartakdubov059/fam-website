
begin;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.can_send_message()
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

revoke all on function private.can_send_message() from public, anon;
grant execute on function private.can_send_message() to authenticated;

drop policy if exists "Send own rate limited messages" on public.messages;
create policy "Send own rate limited messages"
on public.messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and receiver_id is not null
  and receiver_id <> (select auth.uid())
  and private.can_send_message()
);

drop function if exists public.can_send_message();

commit;
