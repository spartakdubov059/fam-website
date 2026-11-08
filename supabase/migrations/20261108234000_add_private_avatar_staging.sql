-- Private staging for profile avatars before the FAM image review agent approves them.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars-pending',
  'avatars-pending',
  false,
  2097152,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "FAM users upload own pending avatars" ON storage.objects;
CREATE POLICY "FAM users upload own pending avatars"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars-pending'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);

DROP POLICY IF EXISTS "FAM users read own pending avatars" ON storage.objects;
CREATE POLICY "FAM users read own pending avatars"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'avatars-pending'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);

DROP POLICY IF EXISTS "FAM users delete own pending avatars" ON storage.objects;
CREATE POLICY "FAM users delete own pending avatars"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'avatars-pending'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);
