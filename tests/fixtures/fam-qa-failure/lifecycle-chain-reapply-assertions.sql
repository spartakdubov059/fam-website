do $$
begin
  if to_regprocedure('public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)') is null then
    raise exception 'Lifecycle resolver was not restored after ordered reapply';
  end if;
  if has_function_privilege('anon','public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)','execute')
      or has_function_privilege('authenticated','public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)','execute')
      or not has_function_privilege('service_role','public.resolve_fam_agent_coder_lifecycle(uuid,text,text,integer,text,text)','execute') then
    raise exception 'Lifecycle resolver grants changed after reapply';
  end if;
end $$;

select 'PASS: lifecycle resolver and service_role-only grants restored' as result;
