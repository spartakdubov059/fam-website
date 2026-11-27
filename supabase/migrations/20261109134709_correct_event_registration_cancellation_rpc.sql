
-- Keep the registration state model unchanged. Cancellation is a server-side
-- deletion of the caller's own row, which also permits a later re-registration.
ALTER TABLE public.event_registrations
  DROP CONSTRAINT IF EXISTS event_registrations_status_check;

ALTER TABLE public.event_registrations
  ADD CONSTRAINT event_registrations_status_check
  CHECK (status IN ('pending', 'confirmed', 'rejected'));

CREATE OR REPLACE FUNCTION private.reserve_event_seat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private'
AS $function$
DECLARE
  v_is_event boolean;
  v_listing_status text;
  v_event_type text;
  v_max_seats integer;
  v_limit integer;
  v_taken integer;
  v_old_reserved boolean := false;
  v_new_reserved boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF new.event_id IS DISTINCT FROM old.event_id
       OR new.user_id IS DISTINCT FROM old.user_id THEN
      RAISE EXCEPTION 'Registration identity cannot be changed';
    END IF;

    IF old.status <> 'pending'
       OR new.status NOT IN ('pending', 'confirmed', 'rejected') THEN
      IF new.status IS DISTINCT FROM old.status THEN
        RAISE EXCEPTION 'Only pending registrations can be processed';
      END IF;
    END IF;

    v_old_reserved := old.status IN ('pending', 'confirmed');
  END IF;

  IF new.status NOT IN ('pending', 'confirmed') THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'New registrations must reserve a seat';
    END IF;
  END IF;

  v_new_reserved := new.status IN ('pending', 'confirmed');

  SELECT l.is_event, l.status, l.event_type, COALESCE(l.max_seats, 0)
    INTO v_is_event, v_listing_status, v_event_type, v_max_seats
  FROM public.listings l
  WHERE l.id = new.event_id
  FOR UPDATE;

  IF NOT FOUND OR v_is_event IS NOT TRUE OR v_listing_status <> 'active' THEN
    RAISE EXCEPTION 'Event is not available for registration';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_event_type = 'request' AND new.status <> 'pending' THEN
      RAISE EXCEPTION 'This event requires organizer approval';
    END IF;
    IF COALESCE(v_event_type, 'open') IN ('open', 'limited') AND new.status <> 'confirmed' THEN
      RAISE EXCEPTION 'Invalid registration status for this event';
    END IF;
  END IF;

  -- Zero means unlimited, matching the existing FAM interface.
  v_limit := CASE WHEN v_event_type = 'limited' THEN v_max_seats ELSE 0 END;

  IF v_new_reserved AND NOT v_old_reserved THEN
    INSERT INTO public.event_occupancy (event_id, taken)
    VALUES (new.event_id, 1)
    ON CONFLICT (event_id) DO UPDATE
      SET taken = public.event_occupancy.taken + 1
      WHERE v_limit <= 0 OR public.event_occupancy.taken < v_limit
    RETURNING taken INTO v_taken;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_SEATS_AVAILABLE';
    END IF;
  END IF;

  RETURN new;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_own_event_registration(p_registration_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
DECLARE
  v_user_id uuid;
  v_registration_id uuid;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Войдите в аккаунт, чтобы отменить запись.'
      USING ERRCODE = '42501';
  END IF;

  IF p_registration_id IS NULL THEN
    RAISE EXCEPTION 'Не указана запись для отмены.'
      USING ERRCODE = '22004';
  END IF;

  DELETE FROM public.event_registrations
   WHERE id = p_registration_id
     AND user_id = v_user_id
     AND status IN ('pending', 'confirmed')
  RETURNING id INTO v_registration_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'registration_not_cancellable'
    );
  END IF;

  -- The existing AFTER DELETE trigger releases the reserved seat atomically.
  RETURN jsonb_build_object(
    'ok', true,
    'registration_id', v_registration_id,
    'status', 'cancelled'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_own_event_registration(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_own_event_registration(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.cancel_own_event_registration(uuid) IS
  'Deletes only the authenticated user own pending or confirmed FAM event registration; seat release is handled by the existing trigger.';
