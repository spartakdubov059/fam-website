begin;

-- Listing image URLs are discoverable outside the authenticated school board.
-- Make both historical buckets private and gate signed URL creation through
-- the same school membership and listing visibility rules as the board.
update storage.buckets
set public = false
where id in ('listings-images', 'listing-images');

drop policy if exists "public_read_listings_images_v2" on storage.objects;
drop policy if exists "public_read_listing_images" on storage.objects;

drop policy if exists "FAM same-school members read approved listing images" on storage.objects;
create policy "FAM same-school members read approved listing images"
on storage.objects for select to authenticated
using (
  bucket_id in ('listings-images', 'listing-images')
  and exists (
    select 1
    from public.listings as l
    join public.profiles as viewer on viewer.id = (select auth.uid())
    where l.photo_status = 'approved'
      and (
        l.user_id = viewer.id
        or (
          l.status = 'active'
          and l.school_id is not null
          and l.school_id = viewer.school_id
        )
      )
      and (
        (
          bucket_id = 'listings-images'
          and split_part(l.image_url, '/storage/v1/object/public/listings-images/', 2) = objects.name
        )
        or (
          bucket_id = 'listing-images'
          and split_part(l.image_url, '/storage/v1/object/public/listing-images/', 2) = objects.name
        )
      )
  )
);

commit;
