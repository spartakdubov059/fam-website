-- Verified same-school request workflow for access to the FAM School Council panel.
CREATE TABLE IF NOT EXISTS public.school_admin_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  school_id text NOT NULL REFERENCES public.schools(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  applicant_note text NOT NULL CHECK (char_length(applicant_note) BETWEEN 5 AND 160),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS school_admin_requests_one_pending_per_user_idx
  ON public.school_admin_requests (user_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS school_admin_requests_user_created_idx
  ON public.school_admin_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS school_admin_requests_school_status_created_idx
  ON public.school_admin_requests (school_id, status, created_at DESC);

ALTER TABLE public.school_admin_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_admin_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.school_admin_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.school_admin_requests TO service_role;

-- The service function exposes only applicants from the reviewer's own school.
CREATE OR REPLACE FUNCTION public.list_school_admin_requests(p_reviewer_id uuid)
RETURNS TABLE (
  request_id uuid,
  user_id uuid,
  applicant_email text,
  applicant_note text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
DECLARE
  v_reviewer public.profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_reviewer
  FROM public.profiles
  WHERE id = p_reviewer_id
  FOR SHARE;

  IF NOT FOUND OR v_reviewer.role <> 'school_admin' OR v_reviewer.school_id IS NULL THEN
    RAISE EXCEPTION 'Нет прав для просмотра заявок'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT r.id, r.user_id, u.email::text, r.applicant_note, r.created_at
  FROM public.school_admin_requests r
  JOIN auth.users u ON u.id = r.user_id
  WHERE r.school_id = v_reviewer.school_id
    AND r.status = 'pending'
  ORDER BY r.created_at ASC
  LIMIT 50;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_school_admin_requests(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_school_admin_requests(uuid) TO service_role;