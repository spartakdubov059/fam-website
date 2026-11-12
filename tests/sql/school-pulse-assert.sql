-- Confirm client has no direct table access and votes are anonymous to peers.
do $check$
begin
if has_table_privilege('authenticated','public.fam_school_poll_votes','SELECT')
   or has_table_privilege('authenticated','public.fam_school_poll_votes','INSERT')
   or has_table_privilege('authenticated','public.fam_school_polls','INSERT')
   or has_table_privilege('anon','public.fam_school_announcements','SELECT') then
   raise exception 'Unexpected direct poll/news grants';end if;
if has_function_privilege('anon','public.fam_pulse_feed()','EXECUTE')
  or has_function_privilege('anon','public.fam_vote_school_poll(uuid,integer)','EXECUTE') then
  raise exception 'Anonymous account can poll or vote';end if;
end $check$;

set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.fam_publish_school_announcement('Короткие новости','Кружки открыты для новых проектов','news');
select public.fam_publish_school_poll('Какой формат встречи выбрать?', '["Кинопоказ","Мастер-класс","Настольные игры"]'::jsonb);

select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
do $check$
declare
 id uuid;
 result jsonb;
begin
select p.id into id from public.fam_school_polls p where p.school_id='school_a';
if id is null then raise exception 'Admin poll missing';end if;
if public.fam_vote_school_poll(id,0) is not true then raise exception 'Vote missing';end if;
if public.fam_vote_school_poll(id,1) is not false then raise exception 'Double-vote possible';end if;
select public.fam_pulse_feed() into result;
if jsonb_array_length(result->'announcements')<>1 or jsonb_array_length(result->'polls')<>1 then
  raise exception 'School feed missing cards';end if;
if result->'polls'->0->'counts'<>'null'::jsonb then raise exception 'Small-cohort votes exposed';end if;
if result::text ~ 'voter_id|author_id|11111111-1111|22222222-2222' then
 raise exception 'Private identifiers in feed';end if;
end $check$;
-- A student cannot create or publish.
do $check$
declare permitted boolean:=false;
begin
  begin
    perform public.fam_publish_school_poll('What about new lessons?','["Yes","No"]'::jsonb);
    permitted:=true;
  exception when others then null;
  end;
  if permitted then raise exception 'Student published official poll';end if;
end $check$;

select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
do $check$
declare result jsonb;
begin
select public.fam_pulse_feed() into result;
if jsonb_array_length(result->'announcements')<>0 or jsonb_array_length(result->'polls')<>0 then
  raise exception 'Another school can view private pulse';end if;
end $check$;
reset role;
