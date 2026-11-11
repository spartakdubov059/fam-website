CREATE OR REPLACE FUNCTION public.finish_listing_image_moderation_task(
  p_queue_id uuid,
  p_state text,
  p_reason_code text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_retry_seconds integer DEFAULT NULL,
  p_image_url text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private'
AS $function$
DECLARE
  v_listing_id uuid;
BEGIN
  IF p_state NOT IN ('approved','rejected','retry','manual_review','failed') THEN
    RAISE EXCEPTION 'invalid_listing_image_moderation_state' USING errcode = '22023';
  END IF;

  SELECT q.listing_id INTO v_listing_id
  FROM private.listing_image_moderation_queue q
  WHERE q.id = p_queue_id
  FOR UPDATE;

  IF v_listing_id IS NULL THEN
    RETURN false;
  END IF;

  IF p_state = 'approved' THEN
    IF p_image_url IS NULL
       AND p_reason_code IS DISTINCT FROM 'text_only_fallback_after_image_quota' THEN
      RAISE EXCEPTION 'approved_image_url_required' USING errcode = '22023';
    END IF;
    IF p_image_url IS NOT NULL AND length(p_image_url) > 2000 THEN
      RAISE EXCEPTION 'approved_image_url_invalid' USING errcode = '22023';
    END IF;
    UPDATE public.listings
    SET status = 'active',
        moderation_status = 'approved',
        image_url = p_image_url
    WHERE id = v_listing_id
      AND status = 'hidden'
      AND moderation_status = 'pending';
  ELSIF p_state = 'rejected' THEN
    UPDATE public.listings
    SET status = 'hidden', moderation_status = 'rejected', image_url = NULL
    WHERE id = v_listing_id;
  ELSIF p_state = 'manual_review' THEN
    UPDATE public.listings
    SET status = 'hidden', moderation_status = 'manual_review', image_url = NULL
    WHERE id = v_listing_id;
  ELSIF p_state = 'failed' THEN
    UPDATE public.listings
    SET status = 'hidden', moderation_status = 'failed', image_url = NULL
    WHERE id = v_listing_id;
  END IF;

  UPDATE private.listing_image_moderation_queue
  SET status = p_state,
      next_attempt_at = CASE
        WHEN p_state = 'retry'
          THEN now() + make_interval(secs => greatest(30, least(coalesce(p_retry_seconds, 300), 3600)))
        ELSE next_attempt_at
      END,
      locked_until = NULL,
      last_reason_code = left(coalesce(p_reason_code, ''), 80),
      last_reason = left(coalesce(p_reason, ''), 180),
      updated_at = now()
  WHERE id = p_queue_id;

  RETURN true;
END;
$function$;
