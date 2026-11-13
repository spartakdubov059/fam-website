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
    moderation_status, is_event, school_id, event_date, event_time, event_type, max_seats,
    photo_status
  ) values (
    p_user_id, btrim(p_title), btrim(p_description), p_category,
    coalesce(nullif(btrim(p_price_text), ''), 'Бесплатно'),
    null, 'hidden', 'pending',
    coalesce(p_is_event, false), p_school_id,
    case when coalesce(p_is_event, false) then p_event_date else null end,
    case when coalesce(p_is_event, false) then p_event_time else null end,
    case when coalesce(p_is_event, false) then coalesce(p_event_type, 'open') else null end,
    case when coalesce(p_is_event, false) and p_event_type = 'limited' then p_max_seats else 0 end,
    'pending'
  )
  returning * into v_listing;

  insert into private.listing_image_moderation_queue (listing_id, user_id, image_path)
  values (v_listing.id, p_user_id, p_image_path);

  return jsonb_build_object('listing_id', v_listing.id, 'status', 'pending');
end;
$function$;

notify pgrst, 'reload schema';
