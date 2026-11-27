
begin;

update storage.buckets
set file_size_limit = 2097152,
    allowed_mime_types = array['image/jpeg','image/png','image/webp']::text[]
where id = 'avatars';

update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg','image/png','image/webp']::text[]
where id = 'listings-images';

drop policy if exists "public_read_listings_images_v2" on storage.objects;
drop policy if exists "user_upload_listings_images_v2" on storage.objects;
drop policy if exists "user_update_listings_images_v2" on storage.objects;
drop policy if exists "user_delete_listings_images_v2" on storage.objects;

create policy "public_read_listings_images_v2"
on storage.objects for select to public
using (bucket_id = 'listings-images');

create policy "user_upload_listings_images_v2"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'listings-images'
  and name like ('listing_' || (select auth.uid())::text || '\_%')
);

create policy "user_update_listings_images_v2"
on storage.objects for update to authenticated
using (
  bucket_id = 'listings-images'
  and name like ('listing_' || (select auth.uid())::text || '\_%')
)
with check (
  bucket_id = 'listings-images'
  and name like ('listing_' || (select auth.uid())::text || '\_%')
);

create policy "user_delete_listings_images_v2"
on storage.objects for delete to authenticated
using (
  bucket_id = 'listings-images'
  and name like ('listing_' || (select auth.uid())::text || '\_%')
);

commit;
