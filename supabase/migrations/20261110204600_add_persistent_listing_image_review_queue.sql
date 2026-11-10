
begin;

alter table public.listings
  add column if not exists moderation_status text not null default 'approved';

alter table public.listings
  drop constraint if exists listings_moderation_status_check;

alter table public.listings
  add constraint listings_moderation_status_check
  check (moderation_status in ('pending','approved','rejected','manual_review','failed'));

comment on column public.listings.moderation_status is
  'Server-owned image/text moderation state. Pending listings remain hidden until approval.';

create table if not exists private.listing_image_moderation_queue (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null unique references public.listings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  image_path text not null,
  status text not null default 'queued'
    check (status in ('queued','processing','retry','approved','rejected','manual_review','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_reason_code text,
  last_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists listing_image_moderation_queue_due_idx
  on private.listing_image_moderation_queue (next_attempt_at, created_at)
  where status in ('queued','retry');

create index if not exists listing_image_moderation_queue_lease_idx
  on private.listing_image_moderation_queue (locked_until)
  where status = 'processing';

alter table private.listing_image_moderation_queue enable row level security;
revoke all on private.listing_image_moderation_queue from public, anon, authenticated;
revoke all on private.listing_image_moderation_queue from service_role;

create or replace function public.enqueue_listing_image_moderation_task(
  p_user_id uuid,
  p_title text,
  p_description text,
  p_category text,
  p_price_text text,
  p_school_id text,
  p_image_path text,
  p_is_event boolean default false,
  p_event_date date default null,
  p_event_time time without time zone default null,
  p_event_type text default null,
  p_max_seats integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_listing public.listings%rowtype;
begin
  if p_user_id is null
    or p_title is null or char_length(btrim(p_title)) not between 1 and 80
    or p_description is null or char_length(btrim(p_description)) not between 1 and 1000
    or p_category not in ('Вещи','Услуги','Творчество','Учёба','Мероприятия')
    or coalesce(char_length(p_price_text), 0) > 50
    or p_image_path is null
    or p_image_path !~ ('^' || p_user_id::text || '/listing_' || p_user_id::text || '_[a-z0-9-]{1,50}\.(jpg|png|webp)$')
  then
    raise exception 'invalid_listing_image_moderation_payload' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = p_user_id
      and p.school_id is not distinct from p_school_id
  ) then
    raise exception 'listing_owner_profile_mismatch' using errcode = '42501';
  end if;

  if coalesce(p_is_event, false) then
    if p_category <> 'Мероприятия'
      or coalesce(p_event_type, 'open') not in ('open','request','limited')
      or (p_event_type = 'limited' and (coalesce(p_max_seats, 0) < 1 or p_max_seats > 500))
    then
      raise exception 'invalid_event_payload' using errcode = '22023';
    end if;
  end if;

  insert into public.listings (
    user_id, title, description, category, price_text, image_url, status,
    moderation_status, is_event, school_id, event_date, event_time, event_type, max_seats
  ) values (
    p_user_id, btrim(p_title), btrim(p_description), p_category,
    coalesce(nullif(btrim(p_price_text), ''), 'Бесплатно'),
    null, 'hidden', 'pending',
    coalesce(p_is_event, false), p_school_id,
    case when coalesce(p_is_event, false) then p_event_date else null end,
    case when coalesce(p_is_event, false) then p_event_time else null end,
    case when coalesce(p_is_event, false) then coalesce(p_event_type, 'open') else null end,
    case when coalesce(p_is_event, false) and p_event_type = 'limited' then p_max_seats else 0 end
  )
  returning * into v_listing;

  insert into private.listing_image_moderation_queue (listing_id, user_id, image_path)
  values (v_listing.id, p_user_id, p_image_path);

  return jsonb_build_object('listing_id', v_listing.id, 'status', 'pending');
end;
$function$;

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
    where (
      q.status in ('queued','retry')
      and q.next_attempt_at <= now()
    ) or (
      q.status = 'processing'
      and q.locked_until < now()
    )
    order by q.next_attempt_at, q.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 2), 4))
  ),
  claimed as (
    update private.listing_image_moderation_queue q
    set status = 'processing',
        attempts = q.attempts + 1,
        locked_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300))),
        updated_at = now()
    from picked
    where q.id = picked.id
    returning q.*
  )
  select
    c.id, l.id, c.user_id, c.image_path, c.attempts,
    l.title, l.description, l.category, l.price_text, l.school_id,
    coalesce(l.is_event, false), l.event_date, l.event_time, l.event_type, coalesce(l.max_seats, 0)
  from claimed c
  join public.listings l on l.id = c.listing_id
  where l.status = 'hidden'
    and l.moderation_status = 'pending';
end;
$function$;

create or replace function public.finish_listing_image_moderation_task(
  p_queue_id uuid,
  p_state text,
  p_reason_code text default null,
  p_reason text default null,
  p_retry_seconds integer default null,
  p_image_url text default null
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
    raise exception 'invalid_listing_image_moderation_state' using errcode = '22023';
  end if;

  select q.listing_id into v_listing_id
  from private.listing_image_moderation_queue q
  where q.id = p_queue_id
  for update;

  if v_listing_id is null then
    return false;
  end if;

  if p_state = 'approved' then
    if p_image_url is null or length(p_image_url) > 2000 then
      raise exception 'approved_image_url_required' using errcode = '22023';
    end if;
    update public.listings
    set status = 'active', moderation_status = 'approved', image_url = p_image_url
    where id = v_listing_id and status = 'hidden' and moderation_status = 'pending';
  elsif p_state = 'rejected' then
    update public.listings
    set status = 'hidden', moderation_status = 'rejected', image_url = null
    where id = v_listing_id;
  elsif p_state = 'manual_review' then
    update public.listings
    set status = 'hidden', moderation_status = 'manual_review', image_url = null
    where id = v_listing_id;
  elsif p_state = 'failed' then
    update public.listings
    set status = 'hidden', moderation_status = 'failed', image_url = null
    where id = v_listing_id;
  end if;

  update private.listing_image_moderation_queue
  set status = p_state,
      next_attempt_at = case
        when p_state = 'retry'
          then now() + make_interval(secs => greatest(30, least(coalesce(p_retry_seconds, 300), 3600)))
        else next_attempt_at
      end,
      locked_until = null,
      last_reason_code = left(coalesce(p_reason_code, ''), 80),
      last_reason = left(coalesce(p_reason, ''), 180),
      updated_at = now()
  where id = p_queue_id;

  return true;
end;
$function$;

revoke all on function public.enqueue_listing_image_moderation_task(uuid,text,text,text,text,text,text,boolean,date,time without time zone,text,integer) from public, anon, authenticated;
revoke all on function public.claim_listing_image_moderation_tasks(integer,integer) from public, anon, authenticated;
revoke all on function public.finish_listing_image_moderation_task(uuid,text,text,text,integer,text) from public, anon, authenticated;

grant execute on function public.enqueue_listing_image_moderation_task(uuid,text,text,text,text,text,text,boolean,date,time without time zone,text,integer) to service_role;
grant execute on function public.claim_listing_image_moderation_tasks(integer,integer) to service_role;
grant execute on function public.finish_listing_image_moderation_task(uuid,text,text,text,integer,text) to service_role;

do $block$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'fam-listing-image-moderation-every-minute'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end;
$block$;

select cron.schedule(
  'fam-listing-image-moderation-every-minute',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://tfacqpljrvfpcrhdovbu.supabase.co/functions/v1/fam-listing-image-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-fam-agent-token',
      (select decrypted_secret from vault.decrypted_secrets where name = 'fam_agent_worker_token')
    ),
    body := '{"limit":1}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);

commit;
