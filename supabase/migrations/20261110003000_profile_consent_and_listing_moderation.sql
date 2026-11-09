-- Adds clear profile identity, explicit consent evidence and reversible listing moderation.
-- Deploy this migration together with the matching frontend and Edge Function changes.
-- These columns are intentionally nullable for existing accounts; old accounts are not
-- silently recorded as having accepted new documents.

alter table public.profiles
  add column if not exists display_name text,
  add column if not exists terms_version text,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists privacy_version text,
  add column if not exists privacy_accepted_at timestamptz;

alter table public.listings
  add column if not exists moderation_reason text,
  add column if not exists moderated_by uuid references auth.users(id) on delete set null,
  add column if not exists moderated_at timestamptz;

-- Backfill an account email only from its own authenticated identity and preserve
-- any nickname already explicitly stored in the profile.
update public.profiles as p
set email = coalesce(nullif(p.email, ''), u.email),
    display_name = coalesce(
      nullif(btrim(p.display_name), ''),
      nullif(left(btrim(coalesce(u.raw_user_meta_data ->> 'display_name', '')), 40), '')
    )
from auth.users as u
where u.id = p.id
  and (p.email is null or p.email = ''
       or p.display_name is null or btrim(p.display_name) = '');

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_school_id text;
  v_display_name text;
  v_terms_version text;
  v_privacy_version text;
begin
  v_terms_version := new.raw_user_meta_data ->> 'terms_version';
  v_privacy_version := new.raw_user_meta_data ->> 'privacy_version';

  if v_terms_version is distinct from '2026-11-10-v1'
     or v_privacy_version is distinct from '2026-11-10-v1' then
    raise exception 'Перед регистрацией необходимо прочитать и принять Пользовательское соглашение и Политику конфиденциальности FAM.'
      using errcode = '22023';
  end if;

  v_display_name := nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 40), '');
  if v_display_name is null or char_length(v_display_name) < 2 then
    raise exception 'Укажите имя или никнейм длиной от 2 до 40 символов.'
      using errcode = '22023';
  end if;

  v_school_id := nullif(left(coalesce(new.raw_user_meta_data ->> 'school_id', ''), 120), '');
  if v_school_id in ('Третий лицей', '3 лицей') then
    v_school_id := 'lyceum_3';
  end if;

  if v_school_id is not null
     and not exists (select 1 from public.schools where id = v_school_id) then
    v_school_id := null;
  end if;

  insert into public.profiles (
    id, email, school_id, role, display_name,
    terms_version, terms_accepted_at,
    privacy_version, privacy_accepted_at
  )
  values (
    new.id, new.email, v_school_id, 'student', v_display_name,
    v_terms_version, pg_catalog.now(),
    v_privacy_version, pg_catalog.now()
  )
  on conflict (id) do nothing;

  return new;
end;
$function$;
