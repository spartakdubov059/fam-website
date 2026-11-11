begin;

-- Student Council members must not be able to read ideas that have not passed
-- automated safety review. School admins retain access to review such items;
-- authors retain access to their own submissions and their own status.
drop policy if exists "Users read own ideas or same-school council reads"
  on public.ideas;

create policy "Authors and same-school admins read ideas; council reads approved ideas"
on public.ideas
for select
to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.school_id = ideas.school_id
      and (
        p.role = 'school_admin'
        or (
          p.role = 'council_member'
          and ideas.ai_status = 'approved'
        )
      )
  )
);

-- Council members may update workflow status only on approved ideas.
-- A school admin may also update a pending item during an adult review.
drop policy if exists "Same-school council updates ideas"
  on public.ideas;

create policy "Same-school admins and council update approved ideas"
on public.ideas
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.school_id = ideas.school_id
      and (
        p.role = 'school_admin'
        or (
          p.role = 'council_member'
          and ideas.ai_status = 'approved'
        )
      )
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.school_id = ideas.school_id
      and (
        p.role = 'school_admin'
        or (
          p.role = 'council_member'
          and ideas.ai_status = 'approved'
        )
      )
  )
);

commit;
