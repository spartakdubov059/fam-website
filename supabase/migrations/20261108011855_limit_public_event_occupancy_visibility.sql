-- Applied to the FAM production database on 2026-11-08.
-- Public clients can read only counters linked to active event listings.
DROP POLICY "Anyone can read event occupancy counts"
  ON public.event_occupancy;

CREATE POLICY "Read occupancy for active events"
  ON public.event_occupancy
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.listings AS l
      WHERE l.id = event_occupancy.event_id
        AND l.is_event IS TRUE
        AND l.status = 'active'
    )
  );
