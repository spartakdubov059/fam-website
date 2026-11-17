-- A school's last administrator must not be deleted or demoted.
-- The per-school transaction lock makes this atomic across simultaneous deletions.
CREATE OR REPLACE FUNCTION private.guard_last_school_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_school_id text;
  v_leaving_admin boolean := false;
  v_other_admins integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_leaving_admin := OLD.role = 'school_admin';
    v_school_id := OLD.school_id;
  ELSE
    v_leaving_admin := OLD.role = 'school_admin'
      AND (NEW.role <> 'school_admin' OR NEW.school_id IS DISTINCT FROM OLD.school_id);
    v_school_id := OLD.school_id;
  END IF;

  IF NOT v_leaving_admin THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'Нельзя удалить или снять полномочия с последнего администратора школы'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_school_id)::bigint);

  SELECT count(*) INTO v_other_admins
  FROM public.profiles p
  WHERE p.school_id = v_school_id
    AND p.role = 'school_admin'
    AND p.id <> OLD.id;

  IF v_other_admins = 0 THEN
    RAISE EXCEPTION 'Нельзя удалить или снять полномочия с последнего администратора школы'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

REVOKE ALL ON FUNCTION private.guard_last_school_admin() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS guard_last_school_admin ON public.profiles;
CREATE TRIGGER guard_last_school_admin
BEFORE DELETE OR UPDATE OF role, school_id
ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION private.guard_last_school_admin();