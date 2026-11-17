-- Allow safety reports to distinguish text moderation of listings from image moderation.
-- Existing values remain valid; no incident data is deleted or rewritten.
ALTER TABLE public.fam_safety_incidents
  DROP CONSTRAINT IF EXISTS fam_safety_incidents_source_kind_check;

ALTER TABLE public.fam_safety_incidents
  ADD CONSTRAINT fam_safety_incidents_source_kind_check
  CHECK (source_kind = ANY (ARRAY[
    'message'::text,
    'idea'::text,
    'listing'::text,
    'image'::text
  ]));
