-- FAM profile identity and registration-consent metadata.
-- Additive only: existing accounts are not deleted or modified beyond NULL new fields.
alter table public.profiles
  add column if not exists display_name text,
  add column if not exists phone_masked text,
  add column if not exists terms_version text,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists personal_data_consent_version text,
  add column if not exists personal_data_consent_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_display_name_length_check'
  ) then
    alter table public.profiles
      add constraint profiles_display_name_length_check
      check (display_name is null or char_length(btrim(display_name)) between 2 and 32);
  end if;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_school_id text;
  v_display_name text;
  v_phone_digits text;
  v_phone_masked text;
  v_terms_version text;
  v_terms_accepted_at timestamptz;
  v_consent_version text;
  v_consent_at timestamptz;
begin
  v_school_id := nullif(left(coalesce(new.raw_user_meta_data->>'school_id', ''), 120), '');

  if v_school_id in ('Третий лицей', '3 лицей') then
    v_school_id := 'lyceum_3';
  end if;

  if v_school_id is not null
     and not exists (select 1 from public.schools where id = v_school_id) then
    v_school_id := null;
  end if;

  v_display_name := nullif(left(btrim(coalesce(new.raw_user_meta_data->>'display_name', '')), 32), '');
  if v_display_name is not null and char_length(v_display_name) < 2 then
    v_display_name := null;
  end if;

  v_phone_digits := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
  v_phone_masked := case
    when char_length(v_phone_digits) >= 4 then '•••• ' || right(v_phone_digits, 4)
    else null
  end;

  v_terms_version := nullif(left(btrim(coalesce(new.raw_user_meta_data->>'fam_terms_version', '')), 40), '');
  v_terms_accepted_at := case
    when new.raw_user_meta_data->>'fam_terms_accepted' = 'true' and v_terms_version is not null then now()
    else null
  end;

  v_consent_version := nullif(left(btrim(coalesce(new.raw_user_meta_data->>'fam_personal_data_consent_version', '')), 40), '');
  v_consent_at := case
    when new.raw_user_meta_data->>'fam_personal_data_consent' = 'true' and v_consent_version is not null then now()
    else null
  end;

  insert into public.profiles (
    id, email, school_id, role, display_name, phone_masked,
    terms_version, terms_accepted_at,
    personal_data_consent_version, personal_data_consent_at
  )
  values (
    new.id, new.email, v_school_id, 'student', v_display_name, v_phone_masked,
    v_terms_version, v_terms_accepted_at,
    v_consent_version, v_consent_at
  )
  on conflict (id) do nothing;

  return new;
end;
$function$;

-- Only the Auth trigger should execute this function.
revoke all on function public.handle_new_user() from public, anon, authenticated;
