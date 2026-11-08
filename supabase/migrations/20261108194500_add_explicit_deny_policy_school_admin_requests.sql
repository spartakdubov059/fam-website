DROP POLICY IF EXISTS "Deny all client access to school admin requests" ON public.school_admin_requests;
CREATE POLICY "Deny all client access to school admin requests"
ON public.school_admin_requests
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);
