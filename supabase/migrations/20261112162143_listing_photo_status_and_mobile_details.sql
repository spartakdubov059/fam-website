begin;

alter table public.listings
  add column if not exists photo_status text not null default 'none';

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'listings_photo_status_check'
      and conrelid = 'public.listings'::regclass
  ) then
    alter table public.listings
      add constraint listings_photo_status_check
      check (photo_status in ('none','pending','approved','rejected','manual_review','failed'));
  end if;
end;
$migration$;

update public.listings
set photo_status = 'approved'
where image_url is not null
  and photo_status <> 'approved';

update public.listings l
set photo_status = case q.status
  when 'queued' then 'pending'
  when 'processing' then 'pending'
  when 'retry' then 'pending'
  when 'approved' then 'approved'
  when 'rejected' then 'rejected'
  when 'manual_review' then 'manual_review'
  when 'failed' then 'failed'
  else 'none'
end
from (
  select distinct on (listing_id) listing_id, status
  from private.listing_image_moderation_queue
  order by listing_id, updated_at desc, created_at desc
) q
where q.listing_id = l.id
  and l.image_url is null;

comment on column public.listings.photo_status is
  'Public-safe photo processing state. The original unreviewed file stays in private storage until approved.';

grant select (photo_status) on public.listings to anon, authenticated;

create or replace function public.finish_listing_image_moderation_task(
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
    set status='active',
        moderation_status='approved',
        image_url=p_image_url,
        photo_status='approved'
    where id=v_listing_id
      and (
        (status='hidden' and moderation_status='pending')
        or (status='active' and moderation_status='approved' and image_url is null)
      );
  elsif p_state='retry' and p_publish_text_only then
    update public.listings
    set status='active',
        moderation_status='approved',
        image_url=null,
        photo_status='pending'
    where id=v_listing_id and status='hidden' and moderation_status='pending';
  elsif p_state='retry' then
    update public.listings
    set photo_status='pending'
    where id=v_listing_id and image_url is null;
  elsif p_state in ('rejected','manual_review','failed') then
    update public.listings
    set photo_status=p_state,
        image_url=null,
        status=case
          when status='hidden' and moderation_status='pending' then 'hidden'
          else status
        end,
        moderation_status=case
          when status='hidden' and moderation_status='pending' then p_state
          else moderation_status
        end
    where id=v_listing_id;
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

revoke all on function public.finish_listing_image_moderation_task(uuid,text,text,text,integer,text,boolean) from public,anon,authenticated;
grant execute on function public.finish_listing_image_moderation_task(uuid,text,text,text,integer,text,boolean) to service_role;

notify pgrst, 'reload schema';

commit;
