-- Distinct FAM council roles, council idea permissions, and privileged-action audit.
CREATE TABLE IF NOT EXISTS public.council_admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id text NOT NULL,
  actor_id uuid NOT NULL,
  target_id uuid,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS council_admin_audit_school_created_idx
  ON public.council_admin_audit (school_id, created_at DESC);
ALTER TABLE public.council_admin_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.council_admin_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Deny client access to council admin audit" ON public.council_admin_audit;
CREATE POLICY "Deny client access to council admin audit"
  ON public.council_admin_audit FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.council_admin_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.council_admin_audit TO service_role;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('student', 'council_member', 'school_admin')) NOT VALID;
ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_role_check;

DROP POLICY IF EXISTS "Users read own ideas or same-school admins read" ON public.ideas;
DROP POLICY IF EXISTS "Same-school admins update ideas" ON public.ideas;
CREATE POLICY "Users read own ideas or same-school council reads"
  ON public.ideas FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.school_id = ideas.school_id
        AND p.role IN ('council_member', 'school_admin')
    )
  );
CREATE POLICY "Same-school council updates ideas"
  ON public.ideas FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.school_id = ideas.school_id
        AND p.role IN ('council_member', 'school_admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.school_id = ideas.school_id
        AND p.role IN ('council_member', 'school_admin')
    )
  );
GRANT UPDATE (admin_status) ON public.ideas TO authenticated;

CREATE OR REPLACE FUNCTION public.review_school_admin_request(
  p_request_id uuid, p_reviewer_id uuid, p_approve boolean, p_note text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_request public.school_admin_requests%ROWTYPE;
  v_reviewer public.profiles%ROWTYPE;
  v_applicant public.profiles%ROWTYPE;
  v_note text;
  v_target_role text;
BEGIN
  IF p_request_id IS NULL OR p_reviewer_id IS NULL OR p_approve IS NULL THEN
    RAISE EXCEPTION 'Недостаточно данных для решения по заявке' USING ERRCODE = '22004';
  END IF;
  SELECT * INTO v_reviewer FROM public.profiles WHERE id = p_reviewer_id FOR UPDATE;
  IF NOT FOUND OR v_reviewer.role <> 'school_admin' OR v_reviewer.school_id IS NULL THEN
    RAISE EXCEPTION 'Нет прав для рассмотрения заявок' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_request FROM public.school_admin_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Заявка не найдена' USING ERRCODE = 'P0002'; END IF;
  IF v_request.status <> 'reviewing' THEN
    RAISE EXCEPTION 'Сначала возьмите заявку на рассмотрение' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.review_started_by IS DISTINCT FROM p_reviewer_id THEN
    RAISE EXCEPTION 'Заявку может завершить только тот администратор, который начал рассмотрение'
      USING ERRCODE = '42501';
  END IF;
  IF v_request.school_id <> v_reviewer.school_id THEN
    RAISE EXCEPTION 'Можно рассматривать заявки только своей школы' USING ERRCODE = '42501';
  END IF;
  IF v_request.user_id = p_reviewer_id THEN
    RAISE EXCEPTION 'Нельзя подтверждать собственную заявку' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_applicant FROM public.profiles WHERE id = v_request.user_id FOR UPDATE;
  IF NOT FOUND OR v_applicant.role <> 'student' OR v_applicant.school_id <> v_request.school_id THEN
    RAISE EXCEPTION 'Данные заявителя больше не соответствуют условиям' USING ERRCODE = '23514';
  END IF;
  IF v_request.applicant_note = 'Администратор' THEN
    v_target_role := 'school_admin';
  ELSIF v_request.applicant_note IN ('Участник Ученического совета', 'Член Ученического совета') THEN
    v_target_role := 'council_member';
  ELSE
    RAISE EXCEPTION 'В заявке указана неизвестная роль' USING ERRCODE = '23514';
  END IF;
  v_note := NULLIF(left(trim(coalesce(p_note, '')), 240), '');
  IF p_approve THEN
    UPDATE public.profiles SET role = v_target_role
    WHERE id = v_request.user_id AND school_id = v_request.school_id AND role = 'student';
    IF NOT FOUND THEN RAISE EXCEPTION 'Не удалось назначить роль' USING ERRCODE = '40001'; END IF;
  END IF;
  UPDATE public.school_admin_requests
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      reviewed_by = p_reviewer_id, reviewed_at = now(), review_note = v_note
  WHERE id = p_request_id;
  INSERT INTO public.council_admin_audit (school_id, actor_id, target_id, action, details)
  VALUES (
    v_request.school_id, p_reviewer_id, v_request.user_id,
    CASE WHEN p_approve THEN 'role_granted' ELSE 'application_rejected' END,
    jsonb_build_object(
      'assigned_role', CASE WHEN p_approve THEN v_target_role ELSE NULL END,
      'requested_role', v_request.applicant_note,
      'request_id', p_request_id
    )
  );
  RETURN jsonb_build_object(
    'ok', true, 'request_id', p_request_id,
    'status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
    'assigned_role', CASE WHEN p_approve THEN v_target_role ELSE NULL END,
    'user_id', v_request.user_id, 'school_id', v_request.school_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_council_role(p_actor_id uuid, p_target_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_target public.profiles%ROWTYPE;
  v_admin_count integer;
BEGIN
  IF p_actor_id IS NULL OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'Не указаны участники операции' USING ERRCODE = '22004';
  END IF;
  IF p_actor_id = p_target_id THEN
    RAISE EXCEPTION 'Нельзя снимать права с собственного аккаунта' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_actor FROM public.profiles WHERE id = p_actor_id FOR UPDATE;
  IF NOT FOUND OR v_actor.role <> 'school_admin' OR v_actor.school_id IS NULL THEN
    RAISE EXCEPTION 'Только администратор может снимать полномочия' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_actor.school_id)::bigint);
  SELECT * INTO v_target FROM public.profiles WHERE id = p_target_id FOR UPDATE;
  IF NOT FOUND OR v_target.school_id IS DISTINCT FROM v_actor.school_id THEN
    RAISE EXCEPTION 'Пользователь не найден в вашей школе' USING ERRCODE = '42501';
  END IF;
  IF v_target.role NOT IN ('council_member', 'school_admin') THEN
    RAISE EXCEPTION 'У пользователя нет полномочий Ученического совета' USING ERRCODE = '22023';
  END IF;
  IF v_target.role = 'school_admin' THEN
    SELECT count(*) INTO v_admin_count FROM public.profiles
    WHERE school_id = v_actor.school_id AND role = 'school_admin';
    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'Нельзя снять права с последнего администратора школы' USING ERRCODE = '42501';
    END IF;
  END IF;
  UPDATE public.profiles SET role = 'student'
  WHERE id = p_target_id AND school_id = v_actor.school_id AND role = v_target.role;
  IF NOT FOUND THEN RAISE EXCEPTION 'Не удалось снять полномочия' USING ERRCODE = '40001'; END IF;
  INSERT INTO public.council_admin_audit (school_id, actor_id, target_id, action, details)
  VALUES (v_actor.school_id, p_actor_id, p_target_id, 'role_revoked',
    jsonb_build_object('previous_role', v_target.role));
  RETURN jsonb_build_object(
    'ok', true, 'target_id', p_target_id,
    'previous_role', v_target.role, 'role', 'student'
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.revoke_council_role(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_council_role(uuid, uuid) TO service_role;
