-- Keep idea attachments private and visible only through the same school-scoped idea access.
begin;

alter table public.ideas
  add column if not exists image_paths text[] not null default '{}'::text[];

alter table public.ideas
  drop constraint if exists ideas_image_paths_limit;
alter table public.ideas
  add constraint ideas_image_paths_limit
  check (cardinality(image_paths) <= 3);
grant select (image_paths) on public.ideas to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('idea-images', 'idea-images', false, 2097152, array['image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "FAM idea authors and same-school staff read idea images" on storage.objects;
create policy "FAM idea authors and same-school staff read idea images"
on storage.objects for select to authenticated
using (
  bucket_id = 'idea-images'
  and exists (
    select 1 from public.ideas i
    where i.user_id::text = (storage.foldername(name))[1]
      and i.image_paths @> array[storage.objects.name]
  )
);
-- Upload, replacement and deletion remain server-side through submit-content.

create or replace function public.list_account_storage_objects(p_user_id uuid)
returns table(bucket_id text, object_name text)
language sql security definer set search_path to 'pg_catalog','storage'
as $function$
  select o.bucket_id,o.name
  from storage.objects o
  where p_user_id is not null and (
    o.owner_id=p_user_id::text
    or (o.bucket_id in ('avatars','event-images','listing-images') and o.name like (p_user_id::text || '/%'))
    or (o.bucket_id='listings-images' and o.name like ('listing_' || p_user_id::text || '_%'))
    or (o.bucket_id='idea-images' and o.name like (p_user_id::text || '/%'))
  );
$function$;
revoke all on function public.list_account_storage_objects(uuid) from public,anon,authenticated;
grant execute on function public.list_account_storage_objects(uuid) to service_role;

commit;
