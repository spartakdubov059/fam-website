begin;

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

revoke all on function public.guard_profile_identity_update() from public, anon, authenticated;

commit;
