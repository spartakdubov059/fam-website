-- FAM private school board: active listings are no longer readable by anonymous
-- visitors or authenticated users from another school. Authors retain read
-- access to their own listings, including drafts and pending moderation.
--
-- IMPORTANT: this does NOT certify school enrollment. A separate enrollment
-- approval flow is required before accepting the whole school.
alter policy "Read active listings or own listings"
  on public.listings
  to authenticated
  using (
    user_id = (select auth.uid())
    or (
      status = 'active'
      and school_id is not null
      and exists (
        select 1
        from public.profiles as viewer
        where viewer.id = (select auth.uid())
          and viewer.school_id = listings.school_id
      )
    )
  );

-- Keep SELECT privilege for anon so existing guest screens get an empty list
-- (HTTP 200) rather than treating expected access denial as a site outage.
-- The revised RLS policy has no anonymous role and returns zero rows to anon.
