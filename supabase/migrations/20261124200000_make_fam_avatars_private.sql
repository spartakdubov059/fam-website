-- FAM school privacy: approved avatar photos should not be world-readable.
-- Existing public URL strings in profiles are retained for backwards-compatible
-- object path resolution; the UI swaps them for short-lived owner-only signed URLs.
-- No storage objects or profile rows are deleted or rewritten here.
update storage.buckets
set public = false
where id = 'avatars' and public is distinct from false;

drop policy if exists "public read avatars" on storage.objects;

create policy "FAM users read own approved avatars"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
