-- Restrict final-lease recovery to tasks actually owned by the Qwen worker.
-- Other manual or user-approved coder tasks must never be closed by this worker's reaper.

do $$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.claim_fam_agent_coder_tasks(text,integer,integer)'::regprocedure
  ) into v_definition;

  v_old := $old$      and t.approval_required = false
      and t.status in ('claimed', 'in_progress')
      and t.lease_expires_at <= pg_catalog.now()$old$;
  v_new := $new$      and t.approval_required = false
      and t.source in ('system', 'scheduled_audit')
      and t.claimed_by = p_worker_id
      and t.status in ('claimed', 'in_progress')
      and t.lease_expires_at <= pg_catalog.now()$new$;

  if pg_catalog.strpos(v_definition, v_old) > 0 then
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  elsif pg_catalog.strpos(v_definition, v_new) = 0 then
    raise exception 'The Qwen reaper predicate has an unexpected shape.';
  end if;

  execute v_definition;
end
$$;
