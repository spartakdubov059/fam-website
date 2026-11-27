-- Council members may not directly remove listings.
-- Ordinary student accounts may continue deleting their own listings.
-- Administrative listing removal is performed only by the trusted server function.

DROP POLICY IF EXISTS "Users delete own listings" ON public.listings;

CREATE POLICY "Ordinary users delete only their own listings"
  ON public.listings
  FOR DELETE
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = 'student'
    )
  );
