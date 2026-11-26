-- Historic school event photos must not be anonymously downloadable.
-- All four existing files have a valid owning profile folder. The current
-- FAM frontend and live event records have no references to this old bucket.
-- Preserve the media objects themselves and permit only the owning account.
update storage.buckets
set public = false
where id = 'event-images' and public is distinct from false;

drop policy if exists "public_read_event_images" on storage.objects;

create policy "FAM users read own archived event images"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'event-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
