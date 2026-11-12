-- SQL must run under a fresh disposable PostgreSQL instance.
do $test$
declare
  a uuid:='f5a84e7c-75ea-4b5c-94e4-2e3f9a8d5a1b';
  l uuid:='8b07e0b4-4fd3-4a95-9715-7cdac57d22b1';
  paths text[];
  hashes text[];
  id uuid;
  count_rows integer;
begin
  if public.fam_claim_free_photo_review_slot() then raise exception 'Quota must default to zero'; end if;
  if not (select relrowsecurity from pg_class where oid='public.listing_photos'::regclass) then
    raise exception 'Public listing_photos must have RLS';
  end if;
  if has_table_privilege('authenticated','public.listing_photos','INSERT')
    or has_table_privilege('authenticated','public.listing_photos','UPDATE')
    or has_table_privilege('authenticated','public.listing_photos','DELETE') then
      raise exception 'Client write grants present'; end if;
  if has_function_privilege('authenticated','public.fam_finish_photo_batch(uuid,text,text[])','EXECUTE')
    or has_function_privilege('authenticated','public.fam_enqueue_photo_batch(uuid,uuid,text[],text[],text)','EXECUTE')
    or has_function_privilege('authenticated','public.fam_record_approved_photo_hashes(uuid,text[],text,text)','EXECUTE') then
    raise exception 'Private admin RPC exposed'; end if;
  paths:=array[
   a::text||'/listing_'||a::text||'_01234567.jpg',
   a::text||'/listing_'||a::text||'_01234568.jpg'
  ];
  hashes:=array[repeat('a',64),repeat('b',64)];
  select public.fam_enqueue_photo_batch(l,a,paths,hashes,'fam-school-photo-v1') into id;
  if id is null then raise exception 'No batch ID'; end if;
  select count(*) into count_rows from public.listing_photos where listing_id=l and public_url is null and review_status='pending';
  if count_rows<>2 then raise exception 'Photos should remain hidden'; end if;
  if (select photo_status from public.listings where public.listings.id=l)<>'pending' then
    raise exception 'Listing pending photo state missing';end if;
  if not exists(select 1 from private.fam_photo_review_batches where private.fam_photo_review_batches.id=id) then
    raise exception 'Batch not queued'; end if;
end $test$;
