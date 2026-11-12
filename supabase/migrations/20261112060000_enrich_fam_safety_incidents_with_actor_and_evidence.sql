-- Add restricted attribution for future safety incidents.
-- Raw IP addresses, password data and unredacted contact details are never stored.
alter table public.fam_safety_incidents
  add column if not exists actor_id uuid,
  add column if not exists target_id uuid,
  add column if not exists source_origin text,
  add column if not exists evidence_excerpt text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.fam_safety_incidents'::regclass
      and conname = 'fam_safety_incidents_source_origin_safe'
  ) then
    alter table public.fam_safety_incidents
      add constraint fam_safety_incidents_source_origin_safe
      check (source_origin is null or (
        char_length(source_origin) between 1 and 120
        and source_origin ~ '^[a-z0-9.-]+$'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.fam_safety_incidents'::regclass
      and conname = 'fam_safety_incidents_evidence_excerpt_length'
  ) then
    alter table public.fam_safety_incidents
      add constraint fam_safety_incidents_evidence_excerpt_length
      check (evidence_excerpt is null or char_length(evidence_excerpt) <= 260);
  end if;
end
$$;

create index if not exists fam_safety_incidents_school_actor_created_idx
  on public.fam_safety_incidents (school_id, actor_id, created_at desc);

create index if not exists fam_safety_incidents_school_target_created_idx
  on public.fam_safety_incidents (school_id, target_id, created_at desc);

comment on column public.fam_safety_incidents.actor_id is
  'Authenticated account that submitted the content which generated this safety signal. Visible only through same-school admin Edge Function.';

comment on column public.fam_safety_incidents.target_id is
  'Message recipient when the incident is tied to a message; otherwise NULL.';

comment on column public.fam_safety_incidents.source_origin is
  'HTTPS origin hostname only; no IP address, path, query string or referrer.';

comment on column public.fam_safety_incidents.evidence_excerpt is
  'Short sanitized excerpt (maximum 260 characters); contact data and links are redacted before storage.';

-- Preserve existing RLS and client revocations on fam_safety_incidents.
