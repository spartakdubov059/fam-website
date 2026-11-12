-- REVIEW DRAFT. Run only in isolated PostgreSQL CI until approved for FAM production.
-- News and polls live by school, with no public vote-level access and no paid AI API.
create table if not exists public.fam_school_announcements (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references public.schools(id),
  author_id uuid not null references auth.users(id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 4 and 90),
  body text not null check (char_length(btrim(body)) between 4 and 450),
  kind text not null default 'news' check (kind in ('news','important')),
  published_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '14 days'),
  created_at timestamptz not null default now(),
  check (expires_at > published_at and expires_at <= published_at+interval '31 days')
);
create index if not exists fam_school_announcements_feed_idx on public.fam_school_announcements(school_id,published_at desc);

create table if not exists public.fam_school_polls (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references public.schools(id),
  author_id uuid not null references auth.users(id) on delete restrict,
  question text not null check (char_length(btrim(question)) between 8 and 140),
  options jsonb not null check (jsonb_typeof(options)='array' and jsonb_array_length(options) between 2 and 4),
  closes_at timestamptz not null default (now()+interval '7 days'),
  created_at timestamptz not null default now(),
  check (closes_at > created_at and closes_at <= created_at+interval '14 days')
);
create index if not exists fam_school_polls_feed_idx on public.fam_school_polls(school_id,created_at desc);

create table if not exists public.fam_school_poll_votes (
  poll_id uuid not null references public.fam_school_polls(id) on delete cascade,
  voter_id uuid not null references auth.users(id) on delete cascade,
  choice_index smallint not null check(choice_index between 0 and 3),
  created_at timestamptz not null default now(),
  primary key(poll_id,voter_id)
);
create index if not exists fam_school_poll_votes_poll_idx on public.fam_school_poll_votes(poll_id,choice_index);

alter table public.fam_school_announcements enable row level security;
alter table public.fam_school_polls enable row level security;
alter table public.fam_school_poll_votes enable row level security;
revoke all on public.fam_school_announcements,public.fam_school_polls,public.fam_school_poll_votes from public,anon,authenticated;

-- Common local policy: trusted school administrators post official content, but no PII, links or numbers resembling phone contacts.
-- Note: local patterns cannot guarantee full safety; administrators must review their content.
create or replace function public.fam_pulse_text_safe(p_value text)
returns boolean
language sql immutable set search_path=''
as $$
  select p_value is not null and
     p_value !~* '(https?://|www[.]|[[:alnum:]_+-]+@[[:alnum:].-]+[.][a-z]{2,})'
     and p_value !~ '[0-9][0-9 +()\-]{6,}[0-9]'
     and p_value !~ '[[:cntrl:]]'
$$;
revoke all on function public.fam_pulse_text_safe(text) from public,anon;
grant execute on function public.fam_pulse_text_safe(text) to authenticated;

create or replace function public.fam_pulse_feed()
returns jsonb
language plpgsql stable security definer set search_path=''
as $$
declare
  who uuid := auth.uid();
  school text;
  news jsonb;
  polls jsonb;
begin
  if who is null then return jsonb_build_object('announcements','[]'::jsonb,'polls','[]'::jsonb);end if;
  select p.school_id into school from public.profiles p where p.id=who and p.school_id is not null;
  if school is null then return jsonb_build_object('announcements','[]'::jsonb,'polls','[]'::jsonb);end if;
  select coalesce(jsonb_agg(to_jsonb(n) order by n.published_at desc),'[]'::jsonb) into news
  from (
    select a.id,a.title,a.body,a.kind,a.published_at
    from public.fam_school_announcements a
    where a.school_id=school and a.published_at<=now() and a.expires_at>now()
    order by a.published_at desc limit 4
  ) n;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,
    'question',p.question,
    'options',p.options,
    'closes_at',p.closes_at,
    'total_votes',(select count(*) from public.fam_school_poll_votes v where v.poll_id=p.id),
    'my_vote',(select v.choice_index from public.fam_school_poll_votes v
      where v.poll_id=p.id and v.voter_id=who),
    -- Return aggregates only if at least five students have voted.
    'counts',case when (select count(*) from public.fam_school_poll_votes v where v.poll_id=p.id)>=5
      then (select coalesce(jsonb_agg((
        select count(*) from public.fam_school_poll_votes v
        where v.poll_id=p.id and v.choice_index=(i-1)
      ) order by i),'[]'::jsonb)
        from generate_series(1,jsonb_array_length(p.options)) i)
      else null end
  ) order by p.created_at desc),'[]'::jsonb) into polls
  from (
    select p.id,p.question,p.options,p.closes_at,p.created_at
    from public.fam_school_polls p
    where p.school_id=school and p.closes_at>now()-interval '7 days'
    order by p.created_at desc limit 3
  ) p;
  return jsonb_build_object('announcements',news,'polls',polls);
end $$;
revoke all on function public.fam_pulse_feed() from public,anon,authenticated;
grant execute on function public.fam_pulse_feed() to authenticated;

create or replace function public.fam_vote_school_poll(p_poll_id uuid,p_choice_index integer)
returns boolean
language plpgsql security definer set search_path=''
as $$
declare
  who uuid := auth.uid();
  school text;
  p public.fam_school_polls%rowtype;
  inserted uuid;
begin
  if who is null or p_poll_id is null then raise exception 'login_required';end if;
  select school_id into school from public.profiles where id=who and school_id is not null;
  if school is null then raise exception 'school_required';end if;
  select * into p from public.fam_school_polls where id=p_poll_id and school_id=school for share;
  if not found then raise exception 'poll_not_found';end if;
  if p.closes_at<=now() then raise exception 'poll_closed';end if;
  if p_choice_index is null or p_choice_index<0 or p_choice_index>=jsonb_array_length(p.options) then
    raise exception 'invalid_choice';end if;
  insert into public.fam_school_poll_votes(poll_id,voter_id,choice_index)
  values (p_poll_id,who,p_choice_index)
  on conflict (poll_id,voter_id) do nothing returning poll_id into inserted;
  return inserted is not null;
end $$;
revoke all on function public.fam_vote_school_poll(uuid,integer) from public,anon,authenticated;
grant execute on function public.fam_vote_school_poll(uuid,integer) to authenticated;

create or replace function public.fam_publish_school_announcement(p_title text,p_body text,p_kind text default 'news')
returns uuid
language plpgsql security definer set search_path=''
as $$
declare
  who uuid := auth.uid();
  school text;
  new_id uuid;
begin
  select school_id into school from public.profiles where id=who and role='school_admin' and school_id is not null;
  if school is null then raise exception 'school_admin_only';end if;
  p_title:=btrim(coalesce(p_title,''));p_body:=btrim(coalesce(p_body,''));
  if char_length(p_title) not between 4 and 90 or char_length(p_body) not between 4 and 450
    or p_kind not in ('news','important')
    or not public.fam_pulse_text_safe(p_title) or not public.fam_pulse_text_safe(p_body) then
    raise exception 'invalid_announcement';end if;
  if (select count(*) from public.fam_school_announcements
    where school_id=school and published_at>=now()-interval '1 day')>=4 then
    raise exception 'daily_announcement_limit';end if;
  insert into public.fam_school_announcements(school_id,author_id,title,body,kind)
  values (school,who,p_title,p_body,p_kind) returning id into new_id;
  return new_id;
end $$;
revoke all on function public.fam_publish_school_announcement(text,text,text) from public,anon,authenticated;
grant execute on function public.fam_publish_school_announcement(text,text,text) to authenticated;

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
  select school_id into school from public.profiles where id=who and role='school_admin' and school_id is not null;
  if school is null then raise exception 'school_admin_only';end if;
  p_question:=btrim(coalesce(p_question,''));
  if p_options is null or jsonb_typeof(p_options)<>'array' then raise exception 'invalid_options';end if;
  num:=jsonb_array_length(p_options);
  if char_length(p_question) not between 8 and 140 or num not between 2 and 4
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
