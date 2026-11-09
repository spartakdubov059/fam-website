CREATE OR REPLACE FUNCTION public.list_school_admin_requests(p_reviewer_id uuid)
RETURNS TABLE (request_id uuid,user_id uuid,applicant_email text,applicant_note text,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, auth
AS $function$
DECLARE v_reviewer public.profiles%ROWTYPE;
BEGIN
 SELECT * INTO v_reviewer FROM public.profiles WHERE id=p_reviewer_id FOR SHARE;
 IF NOT FOUND OR v_reviewer.role<>'school_admin' OR v_reviewer.school_id IS NULL THEN RAISE EXCEPTION 'Нет прав для просмотра заявок' USING ERRCODE='42501'; END IF;
 RETURN QUERY
 SELECT r.id,r.user_id,u.email::text,r.applicant_note,r.created_at
 FROM public.school_admin_requests r JOIN auth.users u ON u.id=r.user_id
 WHERE r.school_id=v_reviewer.school_id AND r.status='pending'
 ORDER BY r.created_at ASC LIMIT 50;
END;
$function$;
REVOKE ALL ON FUNCTION public.list_school_admin_requests(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_school_admin_requests(uuid) TO service_role;
