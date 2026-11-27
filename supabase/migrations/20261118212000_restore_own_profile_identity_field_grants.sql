-- FAM: the 2026-11-16 identity extension introduced three SELECT fields
-- without granting them to authenticated users. The new homepage queried
-- those columns and received HTTP 403, displaying an empty-looking profile.
--
-- Keep the existing column-level access model: no whole-table SELECT/UPDATE,
-- and no grants for anon. RLS still restricts profiles to auth.uid() = id.
do $$
begin
  if not exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'profiles'
       and c.relrowsecurity
  ) then
    raise exception 'FAM profiles RLS must be enabled before restoring grants';
  end if;
end;
$$;

grant select (person_type, staff_position, staff_verification_status)
  on table public.profiles to authenticated;

-- Editable identity fields only. Verification and role fields must remain
-- server-controlled. The existing guard_profile_identity_update trigger
-- places edited staff details back into pending verification.
grant update (person_type, staff_position)
  on table public.profiles to authenticated;
