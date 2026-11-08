
begin;

create table if not exists private.content_rate_limits (
  user_id uuid not null,
  kind text not null check (kind in ('listing','idea','message')),
  window_started_at timestamptz not null default now(),
  submission_count integer not null default 0 check (submission_count >= 0),
  primary key (user_id, kind)
);

alter table private.content_rate_limits enable row level security;
revoke all on table private.content_rate_limits from public, anon, authenticated, service_role;

create or replace function public.consume_content_quota(
  p_user_id uuid,
  p_kind text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window interval;
  v_limit integer;
  v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized';
  end if;

  if p_user_id is null then
    raise exception 'invalid_user';
  end if;

  case p_kind
    when 'message' then
      v_window := interval '1 minute';
      v_limit := 8;
    when 'listing' then
      v_window := interval '1 hour';
      v_limit := 5;
    when 'idea' then
      v_window := interval '1 hour';
      v_limit := 5;
    else
      raise exception 'invalid_content_kind';
  end case;

  insert into private.content_rate_limits (
    user_id, kind, window_started_at, submission_count
  )
  values (p_user_id, p_kind, now(), 1)
  on conflict (user_id, kind) do update
  set
    submission_count = case
      when private.content_rate_limits.window_started_at + v_window > now()
        then private.content_rate_limits.submission_count + 1
      else 1
    end,
    window_started_at = case
      when private.content_rate_limits.window_started_at + v_window > now()
        then private.content_rate_limits.window_started_at
      else now()
    end
  returning submission_count into v_count;

  return v_count <= v_limit;
end;
$$;

revoke all on function public.consume_content_quota(uuid,text) from public, anon, authenticated;
grant execute on function public.consume_content_quota(uuid,text) to service_role;

-- Content must only be created by the authenticated Edge Function after moderation.
drop policy if exists "Authenticated users create own listings" on public.listings;
revoke insert on table public.listings from public, anon, authenticated;

-- No client-side update route currently exists. Prevent clients from changing
-- title/description/status after moderation through the REST API.
revoke update on table public.listings from public, anon, authenticated;

drop policy if exists "Users insert own ideas" on public.ideas;
revoke insert on table public.ideas from public, anon, authenticated;

-- Admins may still update the moderation workflow state only.
revoke update on table public.ideas from public, anon, authenticated;
grant update (admin_status) on table public.ideas to authenticated;

drop policy if exists "Send own rate limited messages" on public.messages;
revoke insert on table public.messages from public, anon, authenticated;

commit;
