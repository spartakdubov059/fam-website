-- FAM profile identity, safer listing moderation, and explicit legal acceptance records.
-- Keep all actual contact values in Auth; expose only masked hints to school administrators.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS phone_hint text,
  ADD COLUMN IF NOT EXISTS accepted_terms_version text,
  ADD COLUMN IF NOT EXISTS accepted_privacy_version text,
  ADD COLUMN IF NOT EXISTS personal_data_consent_at timestamptz;

UPDATE public.profiles AS p
SET
  email = COALESCE(NULLIF(p.email, ''), u.email),
  display_name = COALESCE(
    NULLIF(BTRIM(p.display_name), ''),
    NULLIF(BTRIM(u.raw_user_meta_data->>'display_name'), ''),
    'Участник ' || UPPER(SUBSTRING(p.id::text, 1, 6))
  ),
  phone_hint = CASE
    WHEN u.phone IS NOT NULL AND LENGTH(REGEXP_REPLACE(u.phone, '[^0-9]', '', 'g')) >= 4
      THEN 'Телефон ••••' || RIGHT(REGEXP_REPLACE(u.phone, '[^0-9]', '', 'g'), 4)
    ELSE p.phone_hint
  END
FROM auth.users AS u
WHERE u.id = p.id;

UPDATE public.profiles
SET display_name = 'Участник ' || UPPER(SUBSTRING(id::text, 1, 6))
WHERE display_name IS NULL OR BTRIM(display_name) = '';

ALTER TABLE public.profiles
  ALTER COLUMN display_name SET DEFAULT 'Участник',
  ALTER COLUMN display_name SET NOT NULL;

-- Keep public-facing nicknames free of obvious contact data and links.
UPDATE public.profiles
SET display_name = 'Участник ' || UPPER(SUBSTRING(id::text, 1, 6))
WHERE char_length(btrim(display_name)) NOT BETWEEN 2 AND 40
   OR display_name ~* '(@|https?://|www\.|[0-9]{9,})';

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_display_name_safe'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_display_name_safe
      CHECK (
        char_length(btrim(display_name)) BETWEEN 2 AND 40
        AND display_name !~* '(@|https?://|www\.|[0-9]{9,})'
      );
  END IF;
END;
$block$;

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS admin_hidden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_hidden_reason text,
  ADD COLUMN IF NOT EXISTS admin_hidden_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS admin_hidden_at timestamptz;

CREATE INDEX IF NOT EXISTS listings_school_admin_hidden_created_idx
  ON public.listings (school_id, admin_hidden, created_at DESC);

CREATE TABLE IF NOT EXISTS private.fam_user_legal_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agreement_version text NOT NULL,
  privacy_notice_version text NOT NULL,
  personal_data_consent_version text NOT NULL,
  registration_method text NOT NULL CHECK (registration_method IN ('email', 'phone')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, agreement_version, personal_data_consent_version)
);

ALTER TABLE private.fam_user_legal_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.fam_user_legal_acceptances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Deny client access to FAM legal acceptance records"
  ON private.fam_user_legal_acceptances;
CREATE POLICY "Deny client access to FAM legal acceptance records"
  ON private.fam_user_legal_acceptances
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);
REVOKE ALL ON TABLE private.fam_user_legal_acceptances FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE private.fam_user_legal_acceptances TO service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private'
AS $function$
DECLARE
  v_school_id text;
  v_display_name text;
  v_phone_hint text;
  v_terms_version text;
  v_privacy_version text;
  v_consent_version text;
  v_method text;
BEGIN
  v_school_id := nullif(left(coalesce(new.raw_user_meta_data->>'school_id', ''), 120), '');

  IF v_school_id IN ('Третий лицей', '3 лицей') THEN
    v_school_id := 'lyceum_3';
  END IF;

  IF v_school_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_school_id) THEN
    v_school_id := NULL;
  END IF;

  v_display_name := left(
    regexp_replace(
      BTRIM(coalesce(new.raw_user_meta_data->>'display_name', '')),
      '[[:cntrl:]]',
      '',
      'g'
    ),
    40
  );
  IF char_length(v_display_name) NOT BETWEEN 2 AND 40
     OR v_display_name ~* '(@|https?://|www\.|[0-9]{9,})' THEN
    RAISE EXCEPTION 'Имя в FAM должно быть псевдонимом длиной 2–40 символов без контактов и ссылок.'
      USING ERRCODE = '22023';
  END IF;

  v_terms_version := nullif(left(coalesce(new.raw_user_meta_data->>'fam_terms_version', ''), 32), '');
  v_privacy_version := nullif(left(coalesce(new.raw_user_meta_data->>'fam_privacy_version', ''), 32), '');
  v_consent_version := nullif(left(coalesce(new.raw_user_meta_data->>'fam_pd_consent_version', ''), 32), '');

  IF new.raw_user_meta_data->>'fam_terms_accepted' IS DISTINCT FROM 'true'
     OR new.raw_user_meta_data->>'fam_pd_consent_accepted' IS DISTINCT FROM 'true'
     OR v_terms_version IS NULL
     OR v_privacy_version IS NULL
     OR v_consent_version IS NULL THEN
    RAISE EXCEPTION 'Для регистрации нужно отдельно принять Пользовательское соглашение и дать согласие на обработку персональных данных.'
      USING ERRCODE = '22023';
  END IF;

  v_phone_hint := CASE
    WHEN new.phone IS NOT NULL AND LENGTH(REGEXP_REPLACE(new.phone, '[^0-9]', '', 'g')) >= 4
      THEN 'Телефон ••••' || RIGHT(REGEXP_REPLACE(new.phone, '[^0-9]', '', 'g'), 4)
    ELSE NULL
  END;

  INSERT INTO public.profiles (id, email, phone_hint, display_name, school_id, role)
  VALUES (new.id, new.email, v_phone_hint, v_display_name, v_school_id, 'student')
  ON CONFLICT (id) DO UPDATE
    SET email = COALESCE(EXCLUDED.email, public.profiles.email),
        phone_hint = COALESCE(EXCLUDED.phone_hint, public.profiles.phone_hint),
        display_name = CASE
          WHEN public.profiles.display_name IS NULL OR BTRIM(public.profiles.display_name) = ''
          THEN EXCLUDED.display_name
          ELSE public.profiles.display_name
        END;

  v_method := CASE WHEN new.phone IS NOT NULL AND new.phone <> '' THEN 'phone' ELSE 'email' END;

  -- The trigger enforces consent even when a client bypasses the registration UI.
  INSERT INTO private.fam_user_legal_acceptances (
    user_id, agreement_version, privacy_notice_version,
    personal_data_consent_version, registration_method
  )
  VALUES (
    new.id, v_terms_version, v_privacy_version,
    v_consent_version, v_method
  )
  ON CONFLICT (user_id, agreement_version, personal_data_consent_version) DO NOTHING;

  UPDATE public.profiles
  SET accepted_terms_version = v_terms_version,
      accepted_privacy_version = v_privacy_version,
      personal_data_consent_at = now()
  WHERE id = new.id;

  RETURN new;
END;
$function$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
