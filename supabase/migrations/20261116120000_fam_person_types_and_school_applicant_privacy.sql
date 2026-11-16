begin;

alter table public.profiles
  add column if not exists person_type text not null default 'student',
  add column if not exists staff_position text,
  add column if not exists staff_verification_status text not null default 'not_required';

alter table public.profiles
  drop constraint if exists profiles_person_type_check;
alter table public.profiles
  add constraint profiles_person_type_check
  check (person_type in ('student', 'school_staff', 'parent'));

alter table public.profiles
  drop constraint if exists profiles_staff_verification_status_check;
alter table public.profiles
  add constraint profiles_staff_verification_status_check
  check (staff_verification_status in ('not_required', 'pending', 'approved', 'rejected'));

alter table public.profiles
  drop constraint if exists profiles_staff_position_length_check;
alter table public.profiles
  add constraint profiles_staff_position_length_check
  check (staff_position is null or char_length(staff_position) <= 100);

alter table public.profiles
  drop constraint if exists profiles_school_staff_position_required_check;
alter table public.profiles
  add constraint profiles_school_staff_position_required_check
  check (person_type <> 'school_staff' or char_length(btrim(coalesce(staff_position, ''))) between 1 and 100);

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
  v_person_type text;
  v_staff_position text;
begin
  v_school_id := nullif(left(coalesce(new.raw_user_meta_data->>'school_id', ''), 120), '');
  if v_school_id in ('Третий лицей', '3 лицей') then v_school_id := 'lyceum_3'; end if;
  if v_school_id is not null and not exists (select 1 from public.schools where id = v_school_id) then
    v_school_id := null;
  end if;

  v_first_name := nullif(left(btrim(coalesce(new.raw_user_meta_data->>'first_name','')),60),'');
  v_last_name := nullif(left(btrim(coalesce(new.raw_user_meta_data->>'last_name','')),60),'');
  v_person_type := coalesce(nullif(new.raw_user_meta_data->>'person_type',''), 'student');
  v_staff_position := nullif(left(btrim(coalesce(new.raw_user_meta_data->>'staff_position','')),100),'');
  v_class_name := nullif(upper(regexp_replace(btrim(coalesce(new.raw_user_meta_data->>'class_name','')), '[[:space:]]+', '', 'g')),'');

  if v_person_type not in ('student', 'school_staff', 'parent') then
    raise exception 'Выберите тип участника.' using errcode = '22023';
  end if;
  if v_first_name is null or v_last_name is null then
    raise exception 'Укажите имя и фамилию.' using errcode = '22023';
  end if;
  if v_person_type = 'student' and
     (v_class_name is null or v_class_name !~ '^(?:[5-9]|1[01])[АБВГК]$') then
    raise exception 'Для ученика выберите класс с 5-го по 11-й.' using errcode = '22023';
  end if;
  if v_person_type = 'school_staff' and v_staff_position is null then
    raise exception 'Для подтверждения укажите должность в школе.' using errcode = '22023';
  end if;
  if v_person_type <> 'student' then v_class_name := null; end if;

  insert into public.profiles (
    id, school_id, role, first_name, last_name, class_name,
    person_type, staff_position, staff_verification_status
  )
  values (
    new.id, v_school_id, 'student', v_first_name, v_last_name, v_class_name,
    v_person_type, v_staff_position,
    case when v_person_type = 'school_staff' then 'pending' else 'not_required' end
  )
  on conflict (id) do update set
    school_id = coalesce(profiles.school_id, excluded.school_id),
    first_name = coalesce(profiles.first_name, excluded.first_name),
    last_name = coalesce(profiles.last_name, excluded.last_name),
    class_name = coalesce(profiles.class_name, excluded.class_name),
    person_type = coalesce(profiles.person_type, excluded.person_type),
    staff_position = coalesce(profiles.staff_position, excluded.staff_position),
    staff_verification_status = coalesce(profiles.staff_verification_status, excluded.staff_verification_status);

  return new;
end;
$function$;

create or replace function public.guard_profile_identity_update()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, auth
as $function$
begin
  if auth.uid() = old.id then
    -- A profile category is descriptive only: users cannot self-assign an app role or school.
    new.role := old.role;
    new.school_id := old.school_id;
    if new.person_type = 'school_staff' then
      if old.person_type is distinct from new.person_type
         or old.staff_position is distinct from new.staff_position then
        new.staff_verification_status := 'pending';
      else
        new.staff_verification_status := old.staff_verification_status;
      end if;
    else
      new.staff_verification_status := 'not_required';
      new.staff_position := null;
    end if;
    if new.person_type <> 'student' then
      new.class_name := null;
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists profiles_guard_identity_update on public.profiles;
create trigger profiles_guard_identity_update
before update
on public.profiles
for each row execute function public.guard_profile_identity_update();
revoke all on function public.guard_profile_identity_update() from public, anon, authenticated;

create or replace function public.list_school_event_applicants()
returns table(
  registration_id uuid,
  event_id uuid,
  event_title text,
  applicant_first_name text,
  applicant_last_name text,
  applicant_class text,
  applicant_person_type text,
  applicant_staff_position text,
  status text,
  created_at timestamptz,
  is_my_event boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $function$
declare
  v_viewer public.profiles%rowtype;
begin
  select * into v_viewer from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Профиль не найден.' using errcode = '42501';
  end if;

  if v_viewer.role not in ('school_admin', 'council_member')
     or v_viewer.school_id is null then
    raise exception 'Нет прав для просмотра заявок.' using errcode = '42501';
  end if;

  return query
  select r.id, e.id, e.title, p.first_name, p.last_name, p.class_name,
         p.person_type, p.staff_position, r.status, r.created_at,
         e.user_id = auth.uid()
  from public.event_registrations r
  join public.listings e on e.id = r.event_id and e.is_event
  join public.profiles p on p.id = r.user_id
  where r.status = 'pending'
    and e.school_id = v_viewer.school_id
    and p.school_id = v_viewer.school_id
  order by r.created_at desc
  limit 200;
end;
$function$;

revoke all on function public.list_school_event_applicants() from public, anon, authenticated;
grant execute on function public.list_school_event_applicants() to authenticated;

create or replace function public.list_pending_school_staff_verifications()
returns table(
  user_id uuid,
  first_name text,
  last_name text,
  staff_position text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $function$
declare
  v_admin public.profiles%rowtype;
begin
  select * into v_admin from public.profiles where id = auth.uid();
  if not found or v_admin.role <> 'school_admin' or v_admin.school_id is null then
    raise exception 'Проверять должности может только администратор школы.' using errcode = '42501';
  end if;
  return query
  select p.id, p.first_name, p.last_name, p.staff_position, p.created_at
  from public.profiles p
  where p.school_id = v_admin.school_id
    and p.person_type = 'school_staff'
    and p.staff_verification_status = 'pending'
  order by p.created_at asc
  limit 100;
end;
$function$;

revoke all on function public.list_pending_school_staff_verifications() from public, anon, authenticated;
grant execute on function public.list_pending_school_staff_verifications() to authenticated;

create or replace function public.review_school_staff_verification(p_user_id uuid, p_decision text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $function$
declare
  v_admin public.profiles%rowtype;
  v_status text;
begin
  select * into v_admin from public.profiles where id = auth.uid();
  if not found or v_admin.role <> 'school_admin' or v_admin.school_id is null then
    raise exception 'Проверять должности может только администратор школы.' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Неизвестное решение.' using errcode = '22023';
  end if;

  update public.profiles
  set staff_verification_status = p_decision
  where id = p_user_id
    and school_id = v_admin.school_id
    and person_type = 'school_staff'
    and staff_verification_status = 'pending'
  returning staff_verification_status into v_status;

  if not found then
    raise exception 'Заявка не найдена или уже рассмотрена.' using errcode = 'P0002';
  end if;
  return v_status;
end;
$function$;

revoke all on function public.review_school_staff_verification(uuid, text) from public, anon, authenticated;
grant execute on function public.review_school_staff_verification(uuid, text) to authenticated;

commit;
