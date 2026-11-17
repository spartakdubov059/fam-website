
begin;

drop policy if exists "user_upload_listings_images_v2" on storage.objects;
drop policy if exists "user_update_listings_images_v2" on storage.objects;
drop policy if exists "user_delete_listings_images_v2" on storage.objects;

create policy "user_upload_listings_images_v2"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'listings-images'
  and left(name, length('listing_' || (select auth.uid())::text || '_'))
      = 'listing_' || (select auth.uid())::text || '_'
);

create policy "user_update_listings_images_v2"
on storage.objects for update to authenticated
using (
  bucket_id = 'listings-images'
  and left(name, length('listing_' || (select auth.uid())::text || '_'))
      = 'listing_' || (select auth.uid())::text || '_'
)
with check (
  bucket_id = 'listings-images'
  and left(name, length('listing_' || (select auth.uid())::text || '_'))
      = 'listing_' || (select auth.uid())::text || '_'
);

create policy "user_delete_listings_images_v2"
on storage.objects for delete to authenticated
using (
  bucket_id = 'listings-images'
  and left(name, length('listing_' || (select auth.uid())::text || '_'))
      = 'listing_' || (select auth.uid())::text || '_'
);

commit;
