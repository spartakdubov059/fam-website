-- FAM temporary account restrictions.
-- Suspended users may still sign in and read their status, but all public-table
-- writes are blocked centrally until expiry or administrator lift.

CREATE TABLE IF NOT EXISTS public.account_suspensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id text NOT NULL REFERENCES public.schools(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  target_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  issued_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  target_role text NOT NULL CHECK (target_role IN ('student','council_member')),
  duration_hours smallint NOT NULL CHECK (duration_hours IN (24,72,168)),
  reason text NOT NULL CHECK (char_length(trim(reason)) BETWEEN 15 AND 400),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','lifted','expired')),
  expires_at timestamptz NOT NULL,
  lifted_at timestamptz,
  lifted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  lift_reason text CHECK (lift_reason IS NULL OR char_length(lift_reason) <= 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'active' AND lifted_at IS NULL AND lifted_by IS NULL)
    OR
    (status IN ('lifted','expired') AND lifted_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS account_suspensions_one_active_per_user_idx
  ON public.account_suspensions (school_id, target_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS account_suspensions_school_active_idx
  ON public.account_suspensions (school_id, status, expires_at DESC);

ALTER TABLE public.account_suspensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_suspensions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Deny client access to account suspensions" ON public.account_suspensions;
CREATE POLICY "Deny client access to account suspensions"
  ON public.account_suspensions
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);
REVOKE ALL ON TABLE public.account_suspensions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.account_suspensions TO service_role;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.is_current_user_suspended()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.account_suspensions s
    WHERE s.target_id = auth.uid()
      AND s.status = 'active'
      AND s.expires_at > now()
  );
$function$;

REVOKE ALL ON FUNCTION private.is_current_user_suspended() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_current_user_suspended() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.reject_writes_from_suspended_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_user_id uuid;
  v_until timestamptz;
  v_reason text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  SELECT s.expires_at, s.reason
    INTO v_until, v_reason
  FROM public.account_suspensions s
  WHERE s.target_id = v_user_id
    AND s.status = 'active'
    AND s.expires_at > now()
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Действия аккаунта временно ограничены до %. Причина: %',
      to_char(v_until AT TIME ZONE 'UTC', 'DD.MM.YYYY HH24:MI UTC'),
      left(v_reason, 240)
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

REVOKE ALL ON FUNCTION private.reject_writes_from_suspended_accounts() FROM PUBLIC, anon, authenticated;

DO $block$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fam_suspension_write_guard ON public.%I', r.relname);
    EXECUTE format(
      'CREATE TRIGGER fam_suspension_write_guard
       BEFORE INSERT OR UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION private.reject_writes_from_suspended_accounts()',
      r.relname
    );
  END LOOP;
END;
$block$;
