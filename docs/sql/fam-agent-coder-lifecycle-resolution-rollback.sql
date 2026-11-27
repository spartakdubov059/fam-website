-- Manual rollback for migration 20261126195410 only.
-- This removes the resolver endpoint and leaves task rows and event history intact.
-- Do not run before the matching migration has been applied and reviewed.

drop function if exists public.resolve_fam_agent_coder_lifecycle(
  uuid, text, text, integer, text, text
);
