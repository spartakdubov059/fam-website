-- The listing image worker also claims and processes the idea and avatar queues.
-- Remove the orphan scheduler that called the missing fam-idea-image-worker (404).
DO $$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid FROM cron.job WHERE jobname = 'fam-idea-image-moderation-every-minute'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;
END
$$;