CREATE TABLE IF NOT EXISTS public.school_admin_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  school_id text NOT NULL REFERENCES public.schools(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  applicant_note text NOT NULL CHECK (char_length(applicant_note) BETWEEN 5 AND 160),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 240)
);
CREATE INDEX IF NOT EXISTS school_admin_requests_school_status_created_idx ON public.school_admin_requests (school_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS school_admin_requests_user_created_idx ON public.school_admin_requests (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS school_admin_requests_one_pending_per_user_idx ON public.school_admin_requests (user_id) WHERE status = 'pending';
ALTER TABLE public.school_admin_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_admin_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.school_admin_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.school_admin_requests TO service_role;
CREATE OR REPLACE FUNCTION public.review_school_admin_request(p_request_id uuid,p_reviewer_id uuid,p_approve boolean,p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
DECLARE v_request public.school_admin_requests%ROWTYPE; v_reviewer public.profiles%ROWTYPE; v_applicant public.profiles%ROWTYPE; v_note text;
BEGIN
 IF p_request_id IS NULL OR p_reviewer_id IS NULL OR p_approve IS NULL THEN RAISE EXCEPTION 'Недостаточно данных для решения по заявке' USING ERRCODE='22004'; END IF;
 SELECT * INTO v_reviewer FROM public.profiles WHERE id=p_reviewer_id FOR UPDATE;
 IF NOT FOUND OR v_reviewer.role<>'school_admin' OR v_reviewer.school_id IS NULL THEN RAISE EXCEPTION 'Нет прав для рассмотрения заявок' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_request FROM public.school_admin_requests WHERE id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Заявка не найдена' USING ERRCODE='P0002'; END IF;
 IF v_request.status<>'pending' THEN RAISE EXCEPTION 'Заявка уже рассмотрена' USING ERRCODE='P0001'; END IF;
 IF v_request.school_id<>v_reviewer.school_id THEN RAISE EXCEPTION 'Можно рассматривать заявки только своего лицея' USING ERRCODE='42501'; END IF;
 IF v_request.user_id=p_reviewer_id THEN RAISE EXCEPTION 'Нельзя подтверждать собственную заявку' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_applicant FROM public.profiles WHERE id=v_request.user_id FOR UPDATE;
 IF NOT FOUND OR v_applicant.role<>'student' OR v_applicant.school_id<>v_request.school_id THEN RAISE EXCEPTION 'Данные заявителя больше не соответствуют условиям' USING ERRCODE='23514'; END IF;
 v_note:=NULLIF(left(trim(coalesce(p_note,'')),240),'');
 IF p_approve THEN
  UPDATE public.profiles SET role='school_admin' WHERE id=v_request.user_id AND school_id=v_request.school_id AND role='student';
  IF NOT FOUND THEN RAISE EXCEPTION 'Не удалось назначить роль' USING ERRCODE='40001'; END IF;
 END IF;
 UPDATE public.school_admin_requests SET status=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, reviewed_by=p_reviewer_id, reviewed_at=now(), review_note=v_note WHERE id=p_request_id;
 RETURN jsonb_build_object('ok',true,'request_id',p_request_id,'status',CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,'user_id',v_request.user_id,'school_id',v_request.school_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.review_school_admin_request(uuid,uuid,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_school_admin_request(uuid,uuid,boolean,text) TO service_role;