begin;

-- Supports queue cleanup and owner-scoped maintenance when a user account is removed.
create index if not exists listing_image_moderation_queue_user_id_idx
  on private.listing_image_moderation_queue (user_id);

-- Explicit deny policies document and enforce that client roles never read or modify
-- private operational counters or pending-image metadata.
drop policy if exists "Deny client access to FAM site error counters"
  on private.fam_site_error_counts;
create policy "Deny client access to FAM site error counters"
  on private.fam_site_error_counts
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Deny client access to listing image moderation queue"
  on private.listing_image_moderation_queue;
create policy "Deny client access to listing image moderation queue"
  on private.listing_image_moderation_queue
  for all to anon, authenticated
  using (false)
  with check (false);

commit;
