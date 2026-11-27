-- Route all public user images through private staging and server-side moderation.
-- Clients may upload only to the private pending buckets. The submit-content
-- Edge Function publishes approved files using the server-side key.

begin;

drop policy if exists "user upload avatar" on storage.objects;
drop policy if exists "user update avatar" on storage.objects;

drop policy if exists "user_upload_event_images" on storage.objects;
drop policy if exists "user_update_event_images" on storage.objects;

drop policy if exists "user_upload_listing_images" on storage.objects;
drop policy if exists "user_update_listing_images" on storage.objects;

drop policy if exists "user_upload_listings_images_v2" on storage.objects;
drop policy if exists "user_update_listings_images_v2" on storage.objects;

-- A profile avatar can only be changed after image moderation in submit-content.
drop policy if exists "Users update own avatar" on public.profiles;
revoke update (avatar_url) on public.profiles from public, anon, authenticated;

comment on column public.profiles.avatar_url is
  'Updated only by the server-side submit-content function after avatar image moderation.';

commit;
