-- Disposable PostgreSQL stub only (not production).
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema auth,public to authenticated;
grant execute on function auth.uid() to authenticated;
create table public.schools(id text primary key);
create table public.profiles(
 id uuid primary key references auth.users(id),
 school_id text references public.schools(id),
 role text not null
);
insert into public.schools(id) values('school_a'),('school_b');
insert into auth.users(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222'),
 ('33333333-3333-4333-8333-333333333333'),
 ('44444444-4444-4444-8444-444444444444');
insert into public.profiles(id,school_id,role) values
 ('11111111-1111-4111-8111-111111111111','school_a','school_admin'),
 ('22222222-2222-4222-8222-222222222222','school_a','student'),
 ('33333333-3333-4333-8333-333333333333','school_b','student'),
 ('44444444-4444-4444-8444-444444444444','school_a','council_member');

-- Legacy unlimited-entry listings must appear as announcements, not as registrations.
create table public.listings(
 id uuid primary key default gen_random_uuid(),school_id text references public.schools(id),
 user_id uuid references auth.users(id),title text not null,description text not null,
 status text not null default 'active',is_event boolean default false,
 max_seats integer,event_date date,event_time time,created_at timestamptz not null default now()
);
insert into public.listings(school_id,title,description,is_event,max_seats,event_date,event_time) values
 ('school_a','Квиз для всех','Ждём всех желающих, записываться не нужно.',true,null,current_date+3,'16:30'),
 ('school_b','Встреча другой школы','Видно только участникам своей школы.',true,0,current_date+2,'15:00'),
 ('school_a','Мероприятие на 10 мест','Это событие остаётся в Афише.',true,10,current_date+4,'17:00');
