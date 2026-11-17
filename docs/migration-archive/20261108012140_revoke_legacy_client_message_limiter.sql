-- The legacy client-callable rate-limit helper is unused after
-- message creation was moved to the submit-content Edge Function.
-- Keep the SECURITY DEFINER helper inaccessible to client sessions.
REVOKE EXECUTE ON FUNCTION private.can_send_message() FROM authenticated;
