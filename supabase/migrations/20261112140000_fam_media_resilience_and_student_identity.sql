begin;

-- Student identity fields are visible through the profile RLS policy to the owner.
-- School administrators receive them only through the same-school server endpoint.
alter table public.profiles
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists class_name text,
  add column if not exists pending_avatar_request_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_first_name_length_check') then
    alter table public.profiles add constraint profiles_first_name_length_check
      check (first_name is null or char_length(btrim(first_name)) between 1 and 60);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_last_name_length_check') then
    alter table public.profiles add constraint profiles_last_name_length_check
      check (last_name is null or char_length(btrim(last_name)) between 1 and 60);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_class_name_format_check') then
    alter table public.profiles add constraint profiles_class_name_format_check
      check (class_name is null or class_name ~ '^[1-9][0-9]?[[:space:]]?[A-Za-zА-Яа-яЁё]?$');
  end if;
end
$$;

grant select (first_name,last_name,class_name) on public.profiles to authenticated;
grant update (first_name,last_name,class_name) on public.profiles to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_school_id text;
  v_first_name text;
  v_last_name text;
  v_class_name text;
begin
  v_school_id := nullif(left(coalesce(new.raw_user_meta_data->>'school_id', ''), 120), '');

  if v_school_id in ('Третий лицей', '3 лицей') then
    v_school_id := 'lyceum_3';
  end if;

  if v_school_id is not null
     and not exists (select 1 from public.schools where id = v_school_id) then
    v_school_id := null;
  end if;

  v_first_name := nullif(left(btrim(coalesce(new.raw_user_meta_data->>'first_name','')),60),'');
  v_last_name := nullif(left(btrim(coalesce(new.raw_user_meta_data->>'last_name','')),60),'');
  v_class_name := nullif(left(upper(regexp_replace(btrim(coalesce(new.raw_user_meta_data->>'class_name','')), '[[:space:]]+', '', 'g')),8),'');

  if v_class_name is not null and v_class_name !~ '^[1-9][0-9]?[A-Za-zА-Яа-яЁё]?$' then
    v_class_name := null;
  end if;

  insert into public.profiles (id, school_id, role, first_name, last_name, class_name)
  values (new.id, v_school_id, 'student', v_first_name, v_last_name, v_class_name)
  on conflict (id) do update set
    school_id = coalesce(profiles.school_id, excluded.school_id),
    first_name = coalesce(profiles.first_name, excluded.first_name),
    last_name = coalesce(profiles.last_name, excluded.last_name),
    class_name = coalesce(profiles.class_name, excluded.class_name);

  return new;
end;
$function$;

-- Private queue for avatars. Public profile images are changed only after a successful image review.
create table if not exists private.avatar_image_moderation_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  image_path text not null,
  status text not null default 'queued'
    check (status in ('queued','processing','retry','approved','rejected','manual_review','failed','superseded')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_reason_code text,
  last_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists avatar_image_moderation_queue_due_idx
  on private.avatar_image_moderation_queue (next_attempt_at, created_at)
  where status in ('queued','retry');

create index if not exists avatar_image_moderation_queue_lease_idx
  on private.avatar_image_moderation_queue (locked_until)
  where status = 'processing';

alter table private.avatar_image_moderation_queue enable row level security;
revoke all on private.avatar_image_moderation_queue from public, anon, authenticated, service_role;

create or replace function public.enqueue_avatar_image_moderation_task(
  p_user_id uuid,
  p_image_path text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_queue_id uuid;
begin
  if p_user_id is null
     or p_image_path is null
     or p_image_path !~ ('^' || p_user_id::text || '/avatar_' || p_user_id::text || '_[a-z0-9-]{1,50}\.(jpg|png|webp)$')
     or not exists (select 1 from public.profiles p where p.id = p_user_id)
  then
    raise exception 'invalid_avatar_moderation_payload' using errcode = '22023';
  end if;

  insert into private.avatar_image_moderation_queue(user_id,image_path)
  values (p_user_id,p_image_path)
  returning id into v_queue_id;

  update public.profiles
  set pending_avatar_request_id = v_queue_id
  where id = p_user_id;

  update private.avatar_image_moderation_queue
  set status = 'superseded',
      locked_until = null,
      last_reason_code = 'newer_avatar_uploaded',
      last_reason = 'A newer avatar upload replaced this request.',
      updated_at = now()
  where user_id = p_user_id
    and id <> v_queue_id
    and status in ('queued','retry','processing','manual_review');

  return jsonb_build_object('queue_id',v_queue_id,'status','queued');
end;
$function$;

create or replace function public.claim_avatar_image_moderation_tasks(
  p_limit integer default 2,
  p_lease_seconds integer default 120
)
returns table (
  queue_id uuid,
  user_id uuid,
  image_path text,
  attempts integer,
  school_id text
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
begin
  return query
  with picked as (
    select q.id
    from private.avatar_image_moderation_queue q
    join public.profiles p on p.id=q.user_id and p.pending_avatar_request_id=q.id
    where (
      q.status in ('queued','retry') and q.next_attempt_at <= now()
    ) or (
      q.status='processing' and q.locked_until < now()
    )
    order by q.next_attempt_at,q.created_at
    for update of q skip locked
    limit greatest(1,least(coalesce(p_limit,2),4))
  ),
  claimed as (
    update private.avatar_image_moderation_queue q
    set status='processing',
        attempts=q.attempts+1,
        locked_until=now()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,120),300))),
        updated_at=now()
    from picked
    where q.id=picked.id
    returning q.*
  )
  select c.id,c.user_id,c.image_path,c.attempts,p.school_id
  from claimed c
  join public.profiles p on p.id=c.user_id and p.pending_avatar_request_id=c.id;
end;
$function$;

create or replace function public.finish_avatar_image_moderation_task(
  p_queue_id uuid,
  p_state text,
  p_reason_code text default null,
  p_reason text default null,
  p_retry_seconds integer default null,
  p_avatar_url text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_user_id uuid;
  v_pointer uuid;
  v_updated integer;
begin
  if p_state not in ('approved','rejected','retry','manual_review','failed') then
    raise exception 'invalid_avatar_moderation_state' using errcode='22023';
  end if;

  select q.user_id into v_user_id
  from private.avatar_image_moderation_queue q
  where q.id=p_queue_id
  for update;

  if v_user_id is null then return false; end if;

  select p.pending_avatar_request_id into v_pointer
  from public.profiles p where p.id=v_user_id for update;

  if p_state='approved' then
    if p_avatar_url is null or length(p_avatar_url)>2000 then
      raise exception 'approved_avatar_url_required' using errcode='22023';
    end if;
    if v_pointer is distinct from p_queue_id then
      update private.avatar_image_moderation_queue
      set status='superseded',locked_until=null,last_reason_code='newer_avatar_uploaded',
          last_reason='A newer avatar upload replaced this request.',updated_at=now()
      where id=p_queue_id;
      return false;
    end if;
    update public.profiles
    set avatar_url=p_avatar_url,pending_avatar_request_id=null
    where id=v_user_id and pending_avatar_request_id=p_queue_id;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then return false; end if;
  elsif p_state in ('rejected','manual_review','failed') then
    update public.profiles
    set pending_avatar_request_id=null
    where id=v_user_id and pending_avatar_request_id=p_queue_id;
  end if;

  update private.avatar_image_moderation_queue
  set status=p_state,
      next_attempt_at=case when p_state='retry'
        then now()+make_interval(secs=>greatest(30,least(coalesce(p_retry_seconds,3600),21600)))
        else next_attempt_at end,
      locked_until=null,
      last_reason_code=left(coalesce(p_reason_code,''),80),
      last_reason=left(coalesce(p_reason,''),180),
      updated_at=now()
  where id=p_queue_id;

  return true;
end;
$function$;

revoke all on function public.enqueue_avatar_image_moderation_task(uuid,text) from public,anon,authenticated;
revoke all on function public.claim_avatar_image_moderation_tasks(integer,integer) from public,anon,authenticated;
revoke all on function public.finish_avatar_image_moderation_task(uuid,text,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.enqueue_avatar_image_moderation_task(uuid,text) to service_role;
grant execute on function public.claim_avatar_image_moderation_tasks(integer,integer) to service_role;
grant execute on function public.finish_avatar_image_moderation_task(uuid,text,text,text,integer,text) to service_role;

-- Retryable image-provider failures no longer consume a fixed retry budget.
-- Keep a safe text-only listing visible while its still-private image is retried.
create or replace function public.claim_listing_image_moderation_tasks(
  p_limit integer default 2,
  p_lease_seconds integer default 90
)
returns table (
  queue_id uuid,
  listing_id uuid,
  user_id uuid,
  image_path text,
  attempts integer,
  title text,
  description text,
  category text,
  price_text text,
  school_id text,
  is_event boolean,
  event_date date,
  event_time time without time zone,
  event_type text,
  max_seats integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
begin
  return query
  with picked as (
    select q.id
    from private.listing_image_moderation_queue q
    join public.listings l on l.id=q.listing_id
    where (
      q.status in ('queued','retry') and q.next_attempt_at <= now()
    ) or (
      q.status='processing' and q.locked_until < now()
    )
    order by q.next_attempt_at,q.created_at
    for update of q skip locked
    limit greatest(1,least(coalesce(p_limit,2),4))
  ),
  claimed as (
    update private.listing_image_moderation_queue q
    set status='processing',
        attempts=q.attempts+1,
        locked_until=now()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,90),300))),
        updated_at=now()
    from picked
    where q.id=picked.id
    returning q.*
  )
  select c.id,l.id,c.user_id,c.image_path,c.attempts,l.title,l.description,l.category,l.price_text,l.school_id,
         coalesce(l.is_event,false),l.event_date,l.event_time,l.event_type,coalesce(l.max_seats,0)
  from claimed c
  join public.listings l on l.id=c.listing_id
  where (
    l.status='hidden' and l.moderation_status='pending'
  ) or (
    l.status='active' and l.moderation_status='approved'
    and l.image_url is null
  );
end;
$function$;

drop function if exists public.finish_listing_image_moderation_task(uuid,text,text,text,integer,text);

create function public.finish_listing_image_moderation_task(
  p_queue_id uuid,
  p_state text,
  p_reason_code text default null,
  p_reason text default null,
  p_retry_seconds integer default null,
  p_image_url text default null,
  p_publish_text_only boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_listing_id uuid;
begin
  if p_state not in ('approved','rejected','retry','manual_review','failed') then
    raise exception 'invalid_listing_image_moderation_state' using errcode='22023';
  end if;

  if p_publish_text_only and (p_state <> 'retry' or p_image_url is not null) then
    raise exception 'invalid_text_only_publish_state' using errcode='22023';
  end if;

  select q.listing_id into v_listing_id
  from private.listing_image_moderation_queue q
  where q.id=p_queue_id
  for update;

  if v_listing_id is null then return false; end if;

  if p_state='approved' then
    if p_image_url is null or length(p_image_url)>2000 then
      raise exception 'approved_image_url_required' using errcode='22023';
    end if;
    update public.listings
    set status='active',moderation_status='approved',image_url=p_image_url
    where id=v_listing_id
      and (
        (status='hidden' and moderation_status='pending')
        or (status='active' and moderation_status='approved' and image_url is null)
      );
  elsif p_state='retry' and p_publish_text_only then
    update public.listings
    set status='active',moderation_status='approved',image_url=null
    where id=v_listing_id and status='hidden' and moderation_status='pending';
  elsif p_state in ('rejected','manual_review','failed') then
    -- A rejected or uncertain image must not hide text that has already passed moderation.
    update public.listings
    set status='hidden',moderation_status=p_state,image_url=null
    where id=v_listing_id and status='hidden' and moderation_status='pending';
  end if;

  update private.listing_image_moderation_queue
  set status=p_state,
      next_attempt_at=case when p_state='retry'
        then now()+make_interval(secs=>greatest(30,least(coalesce(p_retry_seconds,300),21600)))
        else next_attempt_at end,
      locked_until=null,
      last_reason_code=left(coalesce(p_reason_code,''),80),
      last_reason=left(coalesce(p_reason,''),180),
      updated_at=now()
  where id=p_queue_id;

  return true;
end;
$function$;

revoke all on function public.enqueue_listing_image_moderation_task(uuid,text,text,text,text,text,text,boolean,date,time without time zone,text,integer) from public,anon,authenticated;
revoke all on function public.claim_listing_image_moderation_tasks(integer,integer) from public,anon,authenticated;
revoke all on function public.finish_listing_image_moderation_task(uuid,text,text,text,integer,text,boolean) from public,anon,authenticated;
grant execute on function public.enqueue_listing_image_moderation_task(uuid,text,text,text,text,text,text,boolean,date,time without time zone,text,integer) to service_role;
grant execute on function public.claim_listing_image_moderation_tasks(integer,integer) to service_role;
grant execute on function public.finish_listing_image_moderation_task(uuid,text,text,text,integer,text,boolean) to service_role;

notify pgrst, 'reload schema';

commit;