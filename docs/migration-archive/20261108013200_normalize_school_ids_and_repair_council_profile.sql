-- Normalize the legacy school label and attach the existing School Council account
-- to the only school offered by the current FAM sign-up form.
UPDATE public.profiles
SET school_id = 'lyceum_3'
WHERE school_id IN ('Третий лицей', '3 лицей');

UPDATE public.profiles
SET school_id = 'lyceum_3'
WHERE role = 'school_admin'
  AND school_id IS NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_school_id text;
BEGIN
  v_school_id := nullif(left(coalesce(new.raw_user_meta_data->>'school_id', ''), 120), '');

  IF v_school_id IN ('Третий лицей', '3 лицей') THEN
    v_school_id := 'lyceum_3';
  END IF;

  IF v_school_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_school_id) THEN
    v_school_id := NULL;
  END IF;

  INSERT INTO public.profiles (id, school_id, role)
  VALUES (new.id, v_school_id, 'student')
  ON CONFLICT (id) DO NOTHING;

  RETURN new;
END;
$function$;
