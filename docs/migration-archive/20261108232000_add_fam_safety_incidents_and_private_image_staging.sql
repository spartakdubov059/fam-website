-- FAM safety signal reporting and private image staging.
-- The incident table stores only categories, time, school and a one-way participant-pair fingerprint.
-- It never stores raw message bodies, emails or participant IDs.

CREATE TABLE IF NOT EXISTS public.fam_safety_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id text NOT NULL,
  pair_fingerprint text NOT NULL CHECK (pair_fingerprint ~ '^[0-9a-f]{64}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('message', 'idea', 'image')),
  category text NOT NULL CHECK (category IN (
    'targeted_harassment',
    'hate_or_discrimination',
    'threat_or_intimidation',
    'negative_personal_call',
    'spam_or_repeated_abuse',
    'unsafe_image',
    'personal_data_in_image',
    'unclear_safety_signal'
  )),
  severity text NOT NULL CHECK (severity IN ('medium', 'high')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);

CREATE INDEX IF NOT EXISTS fam_safety_incidents_school_created_idx
  ON public.fam_safety_incidents (school_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fam_safety_incidents_pair_created_idx
  ON public.fam_safety_incidents (pair_fingerprint, created_at DESC);

ALTER TABLE public.fam_safety_incidents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fam_safety_incidents FROM anon, authenticated;
GRANT ALL ON TABLE public.fam_safety_incidents TO service_role;

COMMENT ON TABLE public.fam_safety_incidents IS
  'Сводные сигналы безопасности FAM. Не хранит тексты сообщений, имена и прямые идентификаторы участников. Доступ только из Edge Functions через service_role.';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'listing-images-pending',
  'listing-images-pending',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "FAM users upload own pending listing images" ON storage.objects;
CREATE POLICY "FAM users upload own pending listing images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'listing-images-pending'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);

DROP POLICY IF EXISTS "FAM users read own pending listing images" ON storage.objects;
CREATE POLICY "FAM users read own pending listing images"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'listing-images-pending'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);

DROP POLICY IF EXISTS "FAM users delete own pending listing images" ON storage.objects;
CREATE POLICY "FAM users delete own pending listing images"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'listing-images-pending'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);
