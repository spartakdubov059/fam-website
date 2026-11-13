-- Require valid student identity at signup and expose school identity only
-- through existing server-validated school administration workflows.

alter table public.profiles drop constraint if exists profiles_class_name_format_check;
alter table public.profiles
  add constraint profiles_class_name_format_check
  check (class_name is null or class_name ~ '^(?:[5-9]|1[01])[АБВГК]$') not valid;

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
  v_class_name := nullif(upper(regexp_replace(btrim(coalesce(new.raw_user_meta_data->>'class_name','')), '[[:space:]]+', '', 'g')),'');

  if v_first_name is null or v_last_name is null or v_class_name is null
     or v_class_name !~ '^(?:[5-9]|1[01])[АБВГК]$' then
    raise exception 'Для регистрации укажите имя, фамилию и класс с 5-го по 11-й.'
      using errcode = '22023';
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

drop function if exists public.list_school_admin_requests(uuid);
create function public.list_school_admin_requests(p_reviewer_id uuid)
returns table(
  request_id uuid,
  user_id uuid,
  applicant_first_name text,
  applicant_last_name text,
  applicant_class text,
  applicant_note text,
  status text,
  created_at timestamptz,
  review_started_at timestamptz,
  review_started_by uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $function$
declare
  v_reviewer public.profiles%rowtype;
begin
  select * into v_reviewer
  from public.profiles
  where id = p_reviewer_id
  for share;

  if not found or v_reviewer.role <> 'school_admin' or v_reviewer.school_id is null then
    raise exception 'Нет прав для просмотра заявок' using errcode = '42501';
  end if;

  return query
  select r.id, r.user_id, p.first_name, p.last_name, p.class_name,
         r.applicant_note, r.status, r.created_at, r.review_started_at, r.review_started_by
  from public.school_admin_requests r
  join public.profiles p on p.id = r.user_id and p.school_id = v_reviewer.school_id
  where r.school_id = v_reviewer.school_id
    and r.status in ('pending', 'reviewing')
  order by r.created_at asc
  limit 50;
end;
$function$;

revoke all on function public.list_school_admin_requests(uuid) from public, anon;
grant execute on function public.list_school_admin_requests(uuid) to authenticated, service_role;

