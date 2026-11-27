-- FAM safety incident metadata is accessed only by trusted server functions.
ALTER TABLE public.fam_safety_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fam_safety_incidents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny client access to FAM safety incidents" ON public.fam_safety_incidents;
CREATE POLICY "Deny client access to FAM safety incidents"
  ON public.fam_safety_incidents
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.fam_safety_incidents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fam_safety_incidents TO service_role;
