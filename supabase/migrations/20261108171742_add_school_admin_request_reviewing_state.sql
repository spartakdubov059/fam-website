-- Add a distinct review stage so duplicate requests and concurrent reviewers are prevented.
ALTER TABLE public.school_admin_requests
  ADD COLUMN IF NOT EXISTS review_started_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_started_at timestamptz;

ALTER TABLE public.school_admin_requests
  DROP CONSTRAINT IF EXISTS school_admin_requests_status_check;
ALTER TABLE public.school_admin_requests
  ADD CONSTRAINT school_admin_requests_status_check
  CHECK (status IN ('pending', 'reviewing', 'approved', 'rejected'));

DROP INDEX IF EXISTS public.school_admin_requests_one_pending_per_user_idx;
CREATE UNIQUE INDEX IF NOT EXISTS school_admin_requests_one_active_per_user_idx
  ON public.school_admin_requests (user_id)
  WHERE status IN ('pending', 'reviewing');

CREATE OR REPLACE FUNCTION public.list_school_admin_requests(p_reviewer_id uuid)
RETURNS TABLE (
  request_id uuid,
  user_id uuid,
  applicant_email text,
  applicant_note text,
  status text,
  created_at timestamptz,
  review_started_at timestamptz,
  review_started_by uuid
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
  SELECT r.id, r.user_id, u.email::text, r.applicant_note, r.status,
         r.created_at, r.review_started_at, r.review_started_by
  FROM public.school_admin_requests r
  JOIN auth.users u ON u.id = r.user_id
  WHERE r.school_id = v_reviewer.school_id
    AND r.status IN ('pending', 'reviewing')
  ORDER BY r.created_at ASC
  LIMIT 50;
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_school_admin_request_review(
  p_request_id uuid,
  p_reviewer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_request public.school_admin_requests%ROWTYPE;
  v_reviewer public.profiles%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_reviewer_id IS NULL THEN
    RAISE EXCEPTION 'Недостаточно данных для начала рассмотрения'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_reviewer
  FROM public.profiles
  WHERE id = p_reviewer_id
  FOR UPDATE;

  IF NOT FOUND OR v_reviewer.role <> 'school_admin' OR v_reviewer.school_id IS NULL THEN
    RAISE EXCEPTION 'Нет прав для рассмотрения заявок'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_request
  FROM public.school_admin_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Заявка не найдена'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'Заявка уже взята на рассмотрение или закрыта'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_request.school_id <> v_reviewer.school_id THEN
    RAISE EXCEPTION 'Можно рассматривать заявки только своего лицея'
      USING ERRCODE = '42501';
  END IF;

  IF v_request.user_id = p_reviewer_id THEN
    RAISE EXCEPTION 'Нельзя рассматривать собственную заявку'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.school_admin_requests
  SET status = 'reviewing',
      review_started_by = p_reviewer_id,
      review_started_at = now()
  WHERE id = p_request_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Заявка уже взята на рассмотрение'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'request_id', p_request_id,
    'status', 'reviewing',
    'review_started_at', now()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_school_admin_request(
  p_request_id uuid,
  p_reviewer_id uuid,
  p_approve boolean,
  p_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_request public.school_admin_requests%ROWTYPE;
  v_reviewer public.profiles%ROWTYPE;
  v_applicant public.profiles%ROWTYPE;
  v_note text;
BEGIN
  IF p_request_id IS NULL OR p_reviewer_id IS NULL OR p_approve IS NULL THEN
    RAISE EXCEPTION 'Недостаточно данных для решения по заявке'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_reviewer
  FROM public.profiles
  WHERE id = p_reviewer_id
  FOR UPDATE;

  IF NOT FOUND OR v_reviewer.role <> 'school_admin' OR v_reviewer.school_id IS NULL THEN
    RAISE EXCEPTION 'Нет прав для рассмотрения заявок'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_request
  FROM public.school_admin_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Заявка не найдена'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_request.status <> 'reviewing' THEN
    RAISE EXCEPTION 'Сначала возьмите заявку на рассмотрение'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_request.review_started_by IS DISTINCT FROM p_reviewer_id THEN
    RAISE EXCEPTION 'Заявку может завершить только тот администратор, который начал рассмотрение'
      USING ERRCODE = '42501';
  END IF;

  IF v_request.school_id <> v_reviewer.school_id THEN
    RAISE EXCEPTION 'Можно рассматривать заявки только своей школы'
      USING ERRCODE = '42501';
  END IF;

  IF v_request.user_id = p_reviewer_id THEN
    RAISE EXCEPTION 'Нельзя подтверждать собственную заявку'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_applicant
  FROM public.profiles
  WHERE id = v_request.user_id
  FOR UPDATE;

  IF NOT FOUND OR v_applicant.role <> 'student'
     OR v_applicant.school_id <> v_request.school_id THEN
    RAISE EXCEPTION 'Данные заявителя больше не соответствуют условиям'
      USING ERRCODE = '23514';
  END IF;

  v_note := NULLIF(left(trim(coalesce(p_note, '')), 240), '');

  IF p_approve THEN
    UPDATE public.profiles
    SET role = 'school_admin'
    WHERE id = v_request.user_id
      AND school_id = v_request.school_id
      AND role = 'student';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Не удалось назначить права Совета'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  UPDATE public.school_admin_requests
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      reviewed_by = p_reviewer_id,
      reviewed_at = now(),
      review_note = v_note
  WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'ok', true,
    'request_id', p_request_id,
    'status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
    'user_id', v_request.user_id,
    'school_id', v_request.school_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_school_admin_requests(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_school_admin_request_review(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_school_admin_request(uuid,uuid,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_school_admin_requests(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.start_school_admin_request_review(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_school_admin_request(uuid,uuid,boolean,text) TO service_role;