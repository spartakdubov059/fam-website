-- Persist who reviewed a council access request and the decision note.
ALTER TABLE public.school_admin_requests
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text;

ALTER TABLE public.school_admin_requests
  DROP CONSTRAINT IF EXISTS school_admin_requests_review_note_check;
ALTER TABLE public.school_admin_requests
  ADD CONSTRAINT school_admin_requests_review_note_check
  CHECK (review_note IS NULL OR char_length(review_note) <= 240);

CREATE OR REPLACE FUNCTION public.list_school_admin_requests(p_reviewer_id uuid)
RETURNS TABLE (
  request_id uuid,
  user_id uuid,
  applicant_email text,
  applicant_note text,
  status text,
  created_at timestamptz,
  reviewed_at timestamptz,
  review_note text
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
  SELECT r.id, r.user_id, u.email::text, r.applicant_note,
         r.status, r.created_at, r.reviewed_at, r.review_note
  FROM public.school_admin_requests r
  JOIN auth.users u ON u.id = r.user_id
  WHERE r.school_id = v_reviewer.school_id
    AND r.status = 'pending'
  ORDER BY r.created_at ASC
  LIMIT 50;
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

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'Заявка уже рассматривается или закрыта'
      USING ERRCODE = 'P0001';
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
REVOKE ALL ON FUNCTION public.review_school_admin_request(uuid,uuid,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_school_admin_requests(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_school_admin_request(uuid,uuid,boolean,text) TO service_role;