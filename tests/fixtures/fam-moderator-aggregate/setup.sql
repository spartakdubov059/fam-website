create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create table public.fam_safety_incidents (
  id uuid primary key,
  school_id text not null,
  pair_fingerprint text not null,
  source_kind text not null,
  category text not null,
  severity text not null,
  created_at timestamptz not null default pg_catalog.now(),
  actor_id uuid,
  target_id uuid,
  source_origin text,
  evidence_excerpt text
);
alter table public.fam_safety_incidents enable row level security;
revoke all on table public.fam_safety_incidents from public, anon, authenticated;
grant select on table public.fam_safety_incidents to service_role;

-- Synthetic records span unrelated schools. Small category groups must stay hidden.
insert into public.fam_safety_incidents
  (id, school_id, pair_fingerprint, source_kind, category, severity,
   created_at, actor_id, target_id, source_origin, evidence_excerpt)
select
  pg_catalog.md5('synthetic-' || n)::uuid,
  'school-' || n::text,
  pg_catalog.repeat('a', 64),
  'message',
  'targeted_harassment',
  'medium',
  pg_catalog.now() - interval '1 day',
  pg_catalog.md5('actor-' || n)::uuid,
  pg_catalog.md5('target-' || n)::uuid,
  'example.invalid',
  'synthetic-only excerpt'
from pg_catalog.generate_series(1, 6) as s(n);

insert into public.fam_safety_incidents
  (id, school_id, pair_fingerprint, source_kind, category, severity,
   created_at, actor_id, target_id, source_origin, evidence_excerpt)
select
  pg_catalog.md5('small-' || n)::uuid,
  'small-school-' || n::text,
  pg_catalog.repeat('b', 64),
  'image',
  'personal_data_in_image',
  'high',
  pg_catalog.now() - interval '1 day',
  pg_catalog.md5('small-actor-' || n)::uuid,
  pg_catalog.md5('small-target-' || n)::uuid,
  'private.example.invalid',
  'synthetic personal-data placeholder'
from pg_catalog.generate_series(1, 1) as s(n);
