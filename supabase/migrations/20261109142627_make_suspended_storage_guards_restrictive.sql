begin;

-- Suspension guards must be RESTRICTIVE. PostgreSQL combines permissive
-- policies with OR, which would let this broad predicate grant writes by
-- itself. RESTRICTIVE policies are ANDed with the bucket/owner allow rules.

drop policy if exists "FAM suspended users cannot upload storage objects" on storage.objects;
create policy "FAM suspended users cannot upload storage objects"
on storage.objects as restrictive
for insert to authenticated
with check (not private.is_current_user_suspended());

drop policy if exists "FAM suspended users cannot modify storage objects" on storage.objects;
create policy "FAM suspended users cannot modify storage objects"
on storage.objects as restrictive
for update to authenticated
using (not private.is_current_user_suspended())
with check (not private.is_current_user_suspended());

drop policy if exists "FAM suspended users cannot delete storage objects" on storage.objects;
create policy "FAM suspended users cannot delete storage objects"
on storage.objects as restrictive
for delete to authenticated
using (not private.is_current_user_suspended());

commit;
