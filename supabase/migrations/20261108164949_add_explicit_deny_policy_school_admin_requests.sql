-- Keep the request table inaccessible through the browser Data API.
ALTER TABLE public.school_admin_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_admin_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny all client access to school admin requests"
  ON public.school_admin_requests;
CREATE POLICY "Deny all client access to school admin requests"
  ON public.school_admin_requests
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.school_admin_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.school_admin_requests TO service_role;