-- FAM account deletion requests, complete cleanup support, and audit anonymization.

CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id text NOT NULL REFERENCES public.schools(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  requester_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  target_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requester_email_masked text,
  target_email_masked text,
  target_role text NOT NULL CHECK (target_role IN ('student', 'council_member')),
  reason_code text NOT NULL CHECK (
    reason_code IN ('rules_violation', 'harassment', 'fake_account', 'spam', 'other')
  ),
  reason text NOT NULL CHECK (char_length(trim(reason)) BETWEEN 15 AND 500),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'approved', 'rejected')),
  reviewer_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 240),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_deletion_requests_school_status_created_idx
  ON public.account_deletion_requests (school_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_requests_one_open_per_target_idx
  ON public.account_deletion_requests (school_id, target_id)
  WHERE target_id IS NOT NULL AND status IN ('pending', 'processing');

ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Deny client access to account deletion requests" ON public.account_deletion_requests;
CREATE POLICY "Deny client access to account deletion requests"
  ON public.account_deletion_requests
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);
REVOKE ALL ON TABLE public.account_deletion_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.account_deletion_requests TO service_role;

ALTER TABLE public.message_limits
  DROP CONSTRAINT IF EXISTS message_limits_user_id_fkey;
ALTER TABLE public.message_limits
  ADD CONSTRAINT message_limits_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.council_admin_audit
  ALTER COLUMN actor_id DROP NOT NULL;

UPDATE public.council_admin_audit a
SET actor_id = NULL
WHERE actor_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = a.actor_id);

UPDATE public.council_admin_audit a
SET target_id = NULL
WHERE target_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = a.target_id);

ALTER TABLE public.council_admin_audit
  DROP CONSTRAINT IF EXISTS council_admin_audit_actor_id_fkey;
ALTER TABLE public.council_admin_audit
  DROP CONSTRAINT IF EXISTS council_admin_audit_target_id_fkey;
ALTER TABLE public.council_admin_audit
  ADD CONSTRAINT council_admin_audit_actor_id_fkey
    FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT council_admin_audit_target_id_fkey
    FOREIGN KEY (target_id) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.list_account_storage_objects(p_user_id uuid)
RETURNS TABLE(bucket_id text, object_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'storage'
AS $function$
  SELECT o.bucket_id, o.name
  FROM storage.objects o
  WHERE p_user_id IS NOT NULL
    AND (
      o.owner_id = p_user_id::text
      OR (
        o.bucket_id IN ('avatars', 'event-images', 'listing-images')
        AND o.name LIKE (p_user_id::text || '/%')
      )
      OR (
        o.bucket_id = 'listings-images'
        AND o.name LIKE ('listing_' || p_user_id::text || '_%')
      )
    );
$function$;

REVOKE ALL ON FUNCTION public.list_account_storage_objects(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_account_storage_objects(uuid) TO service_role;