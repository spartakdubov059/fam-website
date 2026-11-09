
-- Add the missing child-side indexes for foreign keys used by school workflows.
CREATE INDEX IF NOT EXISTS account_deletion_requests_requester_id_idx
  ON public.account_deletion_requests (requester_id);
CREATE INDEX IF NOT EXISTS account_deletion_requests_reviewer_id_idx
  ON public.account_deletion_requests (reviewer_id);
CREATE INDEX IF NOT EXISTS account_deletion_requests_target_id_idx
  ON public.account_deletion_requests (target_id);

CREATE INDEX IF NOT EXISTS account_suspensions_issued_by_idx
  ON public.account_suspensions (issued_by);
CREATE INDEX IF NOT EXISTS account_suspensions_lifted_by_idx
  ON public.account_suspensions (lifted_by);
CREATE INDEX IF NOT EXISTS account_suspensions_target_id_idx
  ON public.account_suspensions (target_id);

CREATE INDEX IF NOT EXISTS council_admin_audit_actor_id_idx
  ON public.council_admin_audit (actor_id);
CREATE INDEX IF NOT EXISTS council_admin_audit_target_id_idx
  ON public.council_admin_audit (target_id);

CREATE INDEX IF NOT EXISTS school_admin_requests_review_started_by_idx
  ON public.school_admin_requests (review_started_by);
CREATE INDEX IF NOT EXISTS school_admin_requests_reviewed_by_idx
  ON public.school_admin_requests (reviewed_by);
