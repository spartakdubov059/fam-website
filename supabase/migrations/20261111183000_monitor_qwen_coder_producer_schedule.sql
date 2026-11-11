-- Include the local Qwen task producer in the read-only technical health audit.
-- The producer is part of the coder-agent chain and must not be silently omitted.

do $$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.get_fam_agent_task_system_health(uuid,text)'::regprocedure
  ) into v_definition;

  v_old := $old$('fam-agent-site-error-audit','30 * * * *')$old$;
  v_new := $new$('fam-agent-site-error-audit','30 * * * *'),
      ('fam-agent-coder-task-producer','10 3 * * *')$new$;

  if pg_catalog.position(v_old in v_definition) > 0 then
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  elsif pg_catalog.position(v_new in v_definition) = 0 then
    raise exception 'The expected cron schedule list has an unexpected shape.';
  end if;

  execute v_definition;
end
$$;
