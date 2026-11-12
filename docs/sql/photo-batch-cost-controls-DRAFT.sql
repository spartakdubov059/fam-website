-- DRAFT ONLY. Do not apply until the authenticated photo-batch API and worker are deployed and tested.
-- Create a real numbered migration with 'supabase migration new' during integration.
-- This stage deliberately sets the quota to ZERO: there is no paid-provider fallback.

create schema if not exists private;

create table if not exists private.fam_photo_review_settings (
  singleton boolean primary key default true check (singleton),
  free_provider_verified boolean not null default false,
  daily_request_cap integer not null default 0 check (daily_request_cap between 0 and 500),
  updated_at timestamptz not null default now()
);
insert into private.fam_photo_review_settings (singleton) values (true)
  on conflict (singleton) do nothing;

create table if not exists private.fam_photo_review_daily_usage (
  review_day date primary key,
  used_requests integer not null default 0 check (used_requests >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists private.fam_photo_approved_hashes (
  user_id uuid not null references auth.users(id) on delete cascade,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  policy_version text not null check (char_length(policy_version) between 3 and 80),
  approved_via text not null check (approved_via in ('ai_review', 'human_review')),
  approved_at timestamptz not null default now(),
  primary key (user_id, content_sha256, policy_version)
);
create index if not exists fam_photo_approved_hashes_expiry on private.fam_photo_approved_hashes(approved_at);

create table if not exists private.fam_photo_review_batches (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null unique references public.listings(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  pending_paths text[] not null check (cardinality(pending_paths) between 2 and 5),
  input_hashes text[] not null check (cardinality(input_hashes) between 2 and 5),
  policy_version text not null,
  state text not null default 'queued'
    check (state in ('queued', 'processing', 'pending_budget', 'manual_review', 'approved', 'rejected', 'failed')),
  attempts smallint not null default 0 check (attempts between 0 and 8),
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fam_photo_batch_claim on private.fam_photo_review_batches (next_attempt_at, created_at)
  where state in ('queued', 'pending_budget');

create table if not exists public.listing_photos (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  position smallint not null check (position between 0 and 4),
  review_status text not null check (review_status in ('approved', 'pending', 'manual_review', 'rejected', 'failed')),
  public_url text,
  created_at timestamptz not null default now(),
  unique(listing_id, position),
  constraint public_only_after_approval check (
    (review_status = 'approved' and public_url is not null and
      public_url like 'https://tfacqpljrvfpcrhdovbu.supabase.co/storage/v1/object/public/listings-images/%')
    or (review_status <> 'approved' and public_url is null)
  )
);
create index if not exists listing_photos_listing_idx on public.listing_photos(listing_id, position);

alter table private.fam_photo_review_settings enable row level security;
alter table private.fam_photo_review_daily_usage enable row level security;
alter table private.fam_photo_approved_hashes enable row level security;
alter table private.fam_photo_review_batches enable row level security;
alter table public.listing_photos enable row level security;

revoke all on private.fam_photo_review_settings, private.fam_photo_review_daily_usage,
  private.fam_photo_approved_hashes, private.fam_photo_review_batches from public, anon, authenticated;
revoke all on public.listing_photos from public, anon, authenticated;
grant select (id, listing_id, position, review_status, public_url, created_at)
  on public.listing_photos to anon, authenticated;

-- No client can insert an image URL or self-approve a photo.
create policy "read only safe photo metadata" on public.listing_photos
  for select to anon, authenticated
  using (
    (review_status = 'approved'
      and exists (select 1 from public.listings l where l.id = listing_id and l.status = 'active'))
    or exists (select 1 from public.listings l where l.id = listing_id and l.user_id = (select auth.uid()))
  );

-- Atomic once-per-day budget; 0 by default; permanently refuses unverified paid providers.
create or replace function public.fam_claim_free_photo_review_slot()
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare cap integer; succeeded boolean;
begin
  select daily_request_cap into cap
  from private.fam_photo_review_settings
  where singleton = true and free_provider_verified = true;
  if coalesce(cap, 0) <= 0 then return false; end if;
  insert into private.fam_photo_review_daily_usage(review_day, used_requests)
  values ((now() at time zone 'utc')::date, 1)
  on conflict (review_day)
  do update set used_requests = private.fam_photo_review_daily_usage.used_requests + 1, updated_at = now()
  where private.fam_photo_review_daily_usage.used_requests < cap
  returning true into succeeded;
  return coalesce(succeeded, false);
end $$;
revoke all on function public.fam_claim_free_photo_review_slot() from public, anon, authenticated;
grant execute on function public.fam_claim_free_photo_review_slot() to service_role;

-- Approved SHA-256 reuse is per-user, per-review-policy and has a 30-day expiry.
-- Trusted-role AI-bypass results MUST NOT be written into this cache.
create or replace function public.fam_cached_approved_photo_hashes(
  p_user_id uuid, p_hashes text[], p_policy_version text)
returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(content_sha256), array[]::text[])
  from private.fam_photo_approved_hashes
  where user_id = p_user_id
    and content_sha256 = any(p_hashes)
    and policy_version = p_policy_version
    and approved_at > now() - interval '30 days'
$$;
revoke all on function public.fam_cached_approved_photo_hashes(uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.fam_cached_approved_photo_hashes(uuid, text[], text)
  to service_role;

-- Must only be called after an actual independent AI or human approval.
create or replace function public.fam_record_approved_photo_hashes(
  p_user_id uuid, p_hashes text[], p_policy_version text, p_reviewed_via text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_reviewed_via not in ('ai_review', 'human_review') or
      cardinality(p_hashes) not between 1 and 5 or
      exists(select 1 from unnest(p_hashes) h where h !~ '^[a-f0-9]{64}$') then
    raise exception 'invalid cache write';
  end if;
  insert into private.fam_photo_approved_hashes(user_id, content_sha256, policy_version, approved_via, approved_at)
  select p_user_id, h, p_policy_version, p_reviewed_via, now() from unnest(p_hashes) h
  on conflict (user_id, content_sha256, policy_version) do update
     set approved_at = now(), approved_via = excluded.approved_via;
end $$;
revoke all on function public.fam_record_approved_photo_hashes(uuid, text[], text, text)
  from public, anon, authenticated;
grant execute on function public.fam_record_approved_photo_hashes(uuid, text[], text, text)
  to service_role;


-- Transactional queue admission. Service-role only, with owner, path, hash and duplicate validation.
create or replace function public.fam_enqueue_photo_batch(
 p_listing_id uuid, p_owner_id uuid, p_pending_paths text[], p_input_hashes text[], p_policy_version text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare batch_id uuid; n integer;
begin
  n := cardinality(p_pending_paths);
  if n not between 2 and 5 or cardinality(p_input_hashes) <> n or
     p_policy_version <> 'fam-school-photo-v1' then
    raise exception 'invalid batch';
  end if;
  if (select count(distinct path) from unnest(p_pending_paths) path) <> n
      or (select count(distinct content_hash) from unnest(p_input_hashes) content_hash) <> n
      or exists (select 1 from unnest(p_input_hashes) h where h !~ '^[a-f0-9]{64}$')
      or exists (select 1 from unnest(p_pending_paths) path
           where path !~ ('^' || p_owner_id::text || '/listing_' || p_owner_id::text ||
              '_[A-Za-z0-9_-]{8,80}\\.(jpg|jpeg|png|webp)$')) then
    raise exception 'invalid photo source';
  end if;
  perform 1 from public.listings l
  where l.id = p_listing_id and l.user_id = p_owner_id
    and l.status = 'active'
    and l.image_url is null
    and coalesce(l.photo_status,'none') in ('none','failed')
  for update;
  if not found then raise exception 'listing not eligible'; end if;
  insert into private.fam_photo_review_batches
    (listing_id,owner_id,pending_paths,input_hashes,policy_version)
  values (p_listing_id,p_owner_id,p_pending_paths,p_input_hashes,p_policy_version)
  returning id into batch_id;
  insert into public.listing_photos(listing_id,position,review_status)
  select p_listing_id,(idx - 1)::smallint,'pending'
  from generate_series(1,n) idx;
  update public.listings set photo_status = 'pending' where id=p_listing_id;
  return batch_id;
end $$;
revoke all on function public.fam_enqueue_photo_batch(uuid,uuid,text[],text[],text)
  from public, anon, authenticated;
grant execute on function public.fam_enqueue_photo_batch(uuid,uuid,text[],text[],text)
  to service_role;


-- Claim batches with a row lock and lease-like next attempt time; service role only.
create or replace function public.fam_claim_photo_batches(p_limit integer default 1)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare result jsonb;
begin
  with claimable as (
    select id from private.fam_photo_review_batches
    where state in ('queued','pending_budget','processing') and next_attempt_at <= now() and attempts < 8
    order by created_at
    limit least(greatest(coalesce(p_limit,1),1),2)
    for update skip locked
  ), claimed as (
    update private.fam_photo_review_batches task
    set state='processing',attempts=attempts+1,updated_at=now(),
        next_attempt_at=now()+interval '10 minutes'
    from claimable where task.id=claimable.id returning task.*
  )
  select coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) into result from claimed;
  return result;
end $$;
revoke all on function public.fam_claim_photo_batches(integer) from public,anon,authenticated;
grant execute on function public.fam_claim_photo_batches(integer) to service_role;

-- Atomic publishing transition. Hidden status is the default; only reviewed
-- and service-published storage URLs can become public.
create or replace function public.fam_finish_photo_batch(
  p_batch_id uuid, p_state text, p_public_urls text[] default null)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare job private.fam_photo_review_batches%rowtype;
declare n integer; i integer;
begin
  select * into job from private.fam_photo_review_batches where id=p_batch_id for update;
  if not found or job.state <> 'processing' then return false; end if;
  if p_state not in ('approved','rejected','manual_review','pending_budget','failed') then
    raise exception 'invalid transition';
  end if;
  if p_state='approved' then
    n:=cardinality(job.pending_paths);
    if cardinality(p_public_urls)<>n or
      (select count(distinct url) from unnest(p_public_urls) url)<>n or
      exists(select 1 from unnest(p_public_urls) url where
        url not like 'https://tfacqpljrvfpcrhdovbu.supabase.co/storage/v1/object/public/listings-images/listing_'||job.owner_id::text||'_%') then
      raise exception 'invalid approved photo urls';
    end if;
    for i in 1..n loop
      update public.listing_photos
      set review_status='approved',public_url=p_public_urls[i]
      where listing_id=job.listing_id and position=(i-1);
      if not found then raise exception 'missing photo slot'; end if;
    end loop;
    update public.listings
    set image_url=p_public_urls[1],photo_status='approved'
    where id=job.listing_id and user_id=job.owner_id;
    if not found then raise exception 'missing listing'; end if;
  else
    update public.listing_photos
    set review_status=case when p_state='pending_budget' then 'pending' else p_state end,
        public_url=null
    where listing_id=job.listing_id;
    update public.listings
    set photo_status=case when p_state='pending_budget' then 'pending' else p_state end
    where id=job.listing_id;
  end if;
  update private.fam_photo_review_batches
  set state=p_state,next_attempt_at=case when p_state='pending_budget' then
     now()+interval '1 day' else now()+interval '100 years' end,updated_at=now()
  where id=p_batch_id;
  return true;
end $$;
revoke all on function public.fam_finish_photo_batch(uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.fam_finish_photo_batch(uuid,text,text[]) to service_role;
