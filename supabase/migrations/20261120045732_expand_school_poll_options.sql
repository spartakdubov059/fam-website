-- Expand school polls to support up to eight answer choices.
-- Existing polls and votes remain unchanged; the vote RPC still validates each choice
-- against the selected poll's actual option count.
alter table public.fam_school_polls
  drop constraint if exists fam_school_polls_options_check;
alter table public.fam_school_polls
  add constraint fam_school_polls_options_check
  check (jsonb_typeof(options)='array' and jsonb_array_length(options) between 2 and 8);

alter table public.fam_school_poll_votes
  drop constraint if exists fam_school_poll_votes_choice_index_check;
alter table public.fam_school_poll_votes
  add constraint fam_school_poll_votes_choice_index_check
  check (choice_index between 0 and 7);

create or replace function public.fam_publish_school_poll(p_question text,p_options jsonb)
returns uuid
language plpgsql security definer set search_path=''
as $$
declare
  who uuid := auth.uid();
  school text;
  new_id uuid;
  num integer;
begin
  select school_id into school from public.profiles where id=who and role in ('school_admin','council_member') and school_id is not null;
  if school is null then raise exception 'trusted_school_role_only';end if;
  p_question:=btrim(coalesce(p_question,''));
  if p_options is null or jsonb_typeof(p_options)<>'array' then raise exception 'invalid_options';end if;
  num:=jsonb_array_length(p_options);
  if char_length(p_question) not between 8 and 140 or num not between 2 and 8
    or not public.fam_pulse_text_safe(p_question) then raise exception 'invalid_poll';end if;
  if exists(select 1 from jsonb_array_elements(p_options) as opt(value)
      where jsonb_typeof(opt.value)<>'string'
        or char_length(btrim(trim(both '"' from opt.value::text))) not between 2 and 70
        or not public.fam_pulse_text_safe(opt.value #>> '{}')) then
    raise exception 'invalid_option_text';end if;
  if (select count(*) from (
       select lower(btrim(opt.value #>> '{}')) item from jsonb_array_elements(p_options) as opt(value)
       group by lower(btrim(opt.value #>> '{}'))
     ) distinct_items)<>num then
    raise exception 'duplicate_options';end if;
  if (select count(*) from public.fam_school_polls where school_id=school
      and created_at>=now()-interval '1 day')>=2 then raise exception 'daily_poll_limit';end if;
  insert into public.fam_school_polls(school_id,author_id,question,options)
  values (school,who,p_question,p_options) returning id into new_id;
  return new_id;
end $$;

revoke all on function public.fam_publish_school_poll(text,jsonb) from public,anon,authenticated;
grant execute on function public.fam_publish_school_poll(text,jsonb) to authenticated;
