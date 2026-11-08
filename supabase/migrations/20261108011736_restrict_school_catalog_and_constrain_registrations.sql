
    -- Keep the school catalog read-only for public client roles.
    REVOKE ALL PRIVILEGES ON TABLE public.schools FROM anon, authenticated;
    GRANT SELECT ON TABLE public.schools TO anon, authenticated;

    -- Enforce required registration identity/status at the database level.
    -- Existing rows were verified to have no NULLs or unsupported statuses.
    ALTER TABLE public.event_registrations
      ALTER COLUMN event_id SET NOT NULL,
      ALTER COLUMN user_id SET NOT NULL,
      ALTER COLUMN status SET NOT NULL;

    ALTER TABLE public.event_registrations
      ADD CONSTRAINT event_registrations_status_check
      CHECK (status IN ('pending', 'confirmed', 'rejected'));
  