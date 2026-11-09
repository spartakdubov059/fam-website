DROP POLICY IF EXISTS "FAM suspended users cannot upload storage objects" ON storage.objects;
CREATE POLICY "FAM suspended users cannot upload storage objects"
  ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT private.is_current_user_suspended());

DROP POLICY IF EXISTS "FAM suspended users cannot modify storage objects" ON storage.objects;
CREATE POLICY "FAM suspended users cannot modify storage objects"
  ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT private.is_current_user_suspended())
  WITH CHECK (NOT private.is_current_user_suspended());

DROP POLICY IF EXISTS "FAM suspended users cannot delete storage objects" ON storage.objects;
CREATE POLICY "FAM suspended users cannot delete storage objects"
  ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT private.is_current_user_suspended());
