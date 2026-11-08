-- The old helper is not part of the current message flow.
-- Messages are created only by the submit-content Edge Function now.
REVOKE EXECUTE ON FUNCTION private.can_send_message() FROM authenticated;
