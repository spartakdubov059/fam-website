create role anon nologin;
create role authenticated nologin;
create schema private;

create table private.fam_site_error_counts (
  hour_bucket timestamptz not null,
  event_code text not null,
  page_area text not null,
  event_count integer not null check (event_count between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (hour_bucket,event_code,page_area)
);
