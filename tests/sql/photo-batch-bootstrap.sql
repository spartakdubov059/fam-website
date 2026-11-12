-- Disposable PostgreSQL-only test database. Never execute in the live FAM project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  status text not null default 'active',
  image_url text,
  photo_status text,
  school_id text not null default 'school_test'
);
insert into auth.users(id) values ('f5a84e7c-75ea-4b5c-94e4-2e3f9a8d5a1b');
insert into public.listings(id,user_id,school_id)
values ('8b07e0b4-4fd3-4a95-9715-7cdac57d22b1','f5a84e7c-75ea-4b5c-94e4-2e3f9a8d5a1b','school_test');
