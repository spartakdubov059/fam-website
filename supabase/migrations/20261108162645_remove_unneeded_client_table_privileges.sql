-- Remove structural privileges that are never needed by FAM browser clients.
-- Row-level security and narrowly scoped SELECT/INSERT/UPDATE/DELETE grants remain
-- responsible for the application access model.
REVOKE TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Internal tables are managed only by trusted server functions.
REVOKE ALL ON TABLE public.events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.school_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.message_limits FROM PUBLIC, anon, authenticated;