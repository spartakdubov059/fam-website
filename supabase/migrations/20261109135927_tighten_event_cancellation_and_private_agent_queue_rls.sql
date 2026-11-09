
-- Allow only authenticated users to delete their own active registration rows.
-- The existing AFTER DELETE trigger releases the reserved seat atomically.
DROP POLICY IF EXISTS "Users can cancel own active event registrations"
  ON public.event_registrations;
CREATE POLICY "Users can cancel own active event registrations"
  ON public.event_registrations
  FOR DELETE
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND status IN ('pending', 'confirmed')
  );

REVOKE DELETE ON TABLE public.event_registrations FROM PUBLIC, anon;
GRANT DELETE ON TABLE public.event_registrations TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_own_event_registration(p_registration_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
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

-- Make the private agent queue explicitly inaccessible to client roles.
ALTER TABLE private.fam_agent_ideas FORCE ROW LEVEL SECURITY;
ALTER TABLE private.fam_agent_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE private.fam_agent_task_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deny_client_access_to_fam_agent_ideas
  ON private.fam_agent_ideas;
CREATE POLICY deny_client_access_to_fam_agent_ideas
  ON private.fam_agent_ideas
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_client_access_to_fam_agent_tasks
  ON private.fam_agent_tasks;
CREATE POLICY deny_client_access_to_fam_agent_tasks
  ON private.fam_agent_tasks
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_client_access_to_fam_agent_task_events
  ON private.fam_agent_task_events;
CREATE POLICY deny_client_access_to_fam_agent_task_events
  ON private.fam_agent_task_events
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
