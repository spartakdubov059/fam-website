-- Applied in production as Supabase migration 20261117212030.
-- Foreign-key indexes for moderation and school feed scale.
-- Additive only; preserves all existing rows and access policies.
create index if not exists avatar_image_moderation_queue_user_id_idx
  on private.avatar_image_moderation_queue (user_id);
create index if not exists fam_school_announcements_author_id_idx
  on public.fam_school_announcements (author_id);
create index if not exists fam_school_polls_author_id_idx
  on public.fam_school_polls (author_id);
create index if not exists fam_school_poll_votes_voter_id_idx
  on public.fam_school_poll_votes (voter_id);
