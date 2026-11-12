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
 ('33333333-3333-4333-8333-333333333333');
insert into public.profiles(id,school_id,role) values
 ('11111111-1111-4111-8111-111111111111','school_a','school_admin'),
 ('22222222-2222-4222-8222-222222222222','school_a','student'),
 ('33333333-3333-4333-8333-333333333333','school_b','student');
