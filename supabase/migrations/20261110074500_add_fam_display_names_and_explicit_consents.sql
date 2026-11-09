-- FAM profile display names and explicit registration-consent records.
-- This migration is prepared for review only; do not apply until the project
-- data-residency and operator/legal details have been approved.

begin;

alter table public.profiles
  add column if not exists display_name text;

do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_display_name_safe_length'
  ) then
    alter table public.profiles
      add constraint profiles_display_name_safe_length
      check (
        display_name is null
        or (
          char_length(btrim(display_name)) between 2 and 32
          and display_name !~* '(@|https?://|www\.|[0-9]{9,})'
        )
      );
  end if;
end;
$block$;

-- Display names are visible to the same-school admin dashboard only through
-- the server-side management function. Keep the browser profile read narrow.
revoke all on table public.profiles from anon, authenticated;
grant select (id, avatar_url, created_at, city, school_id, role, display_name)
  on public.profiles to authenticated;
grant update (avatar_url) on public.profiles to authenticated;

create schema if not exists private;

create table if not exists private.user_consents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  terms_version text not null,
  privacy_version text not null,
  terms_accepted_at timestamptz not null,
  privacy_accepted_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint user_consents_terms_version_nonempty check (char_length(btrim(terms_version)) between 1 and 20),
  constraint user_consents_privacy_version_nonempty check (char_length(btrim(privacy_version)) between 1 and 20)
);

alter table private.user_consents enable row level security;
alter table private.user_consents force row level security;
drop policy if exists deny_client_access_to_user_consents on private.user_consents;
create policy deny_client_access_to_user_consents
  on private.user_consents
  for all to anon, authenticated
  using (false)
  with check (false);

revoke all on table private.user_consents from public, anon, authenticated;
grant select, insert on table private.user_consents to service_role;
grant usage on schema private to service_role;

-- A new account is created only when the registration flow explicitly submits
-- both consent flags and supported document versions. Existing accounts remain.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_display_name text;
  v_terms_version text;
  v_privacy_version text;
begin
  if coalesce(new.raw_user_meta_data->>'fam_terms_accepted', '') <> 'true'
     or coalesce(new.raw_user_meta_data->>'fam_privacy_accepted', '') <> 'true' then
    raise exception 'Для регистрации требуется отдельно принять Пользовательское соглашение и условия обработки данных.'
      using errcode = '22023';
  end if;

  v_terms_version := left(coalesce(new.raw_user_meta_data->>'fam_terms_version', ''), 20);
  v_privacy_version := left(coalesce(new.raw_user_meta_data->>'fam_privacy_version', ''), 20);
  if v_terms_version <> '1.0' or v_privacy_version <> '1.0' then
    raise exception 'Версия документов регистрации не поддерживается. Обновите страницу и попробуйте снова.'
      using errcode = '22023';
  end if;

  v_display_name := nullif(btrim(left(coalesce(new.raw_user_meta_data->>'display_name', ''), 32)), '');
  if v_display_name is not null and (
    char_length(v_display_name) < 2
    or v_display_name ~* '(@|https?://|www\.|[0-9]{9,})'
  ) then
    raise exception 'Имя в FAM должно быть псевдонимом без контактов и ссылок.'
      using errcode = '22023';
  end if;

  insert into public.profiles (id, school_id, role, display_name)
  values (
    new.id,
    nullif(left(coalesce(new.raw_user_meta_data->>'school_id', ''), 120), ''),
    'student',
    v_display_name
  )
  on conflict (id) do nothing;

  insert into private.user_consents (
    user_id, terms_version, privacy_version, terms_accepted_at, privacy_accepted_at
  )
  values (new.id, v_terms_version, v_privacy_version, pg_catalog.now(), pg_catalog.now())
  on conflict (user_id) do nothing;

  return new;
end;
$function$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

commit;
