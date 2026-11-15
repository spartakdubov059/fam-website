begin;

create table if not exists private.idea_image_moderation_queue (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  school_id text not null,
  image_path text not null unique,
  status text not null default 'queued'
    check (status in ('queued','processing','retry','approved','rejected','manual_review','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_reason_code text,
  last_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idea_image_moderation_queue_due_idx
  on private.idea_image_moderation_queue (next_attempt_at, created_at)
  where status in ('queued','retry');
create index if not exists idea_image_moderation_queue_lease_idx
  on private.idea_image_moderation_queue (locked_until)
  where status = 'processing';
create index if not exists idea_image_moderation_queue_user_idx on private.idea_image_moderation_queue(user_id);
create index if not exists idea_image_moderation_queue_user_idx
  on private.idea_image_moderation_queue (user_id);
alter table private.idea_image_moderation_queue enable row level security;
revoke all on private.idea_image_moderation_queue from public, anon, authenticated, service_role;

create or replace function public.enqueue_idea_image_moderation_task(
  p_idea_id uuid,p_user_id uuid,p_school_id text,p_image_path text
) returns boolean language plpgsql security definer
set search_path=pg_catalog,public,private as $function$
begin
  if p_idea_id is null or p_user_id is null or nullif(btrim(p_school_id),'') is null
    or p_image_path is null
    or p_image_path !~ ('^'||p_user_id::text||'/idea_[a-z0-9-]{1,50}\.(jpg|png|webp)$') then
    raise exception 'invalid_idea_image_queue_payload' using errcode='22023';
  end if;
  if not exists(select 1 from public.ideas i where i.id=p_idea_id and i.user_id=p_user_id
    and i.school_id=p_school_id and i.ai_status='pending' and i.image_paths @> array[p_image_path]) then
    raise exception 'idea_image_queue_owner_mismatch' using errcode='42501';
  end if;
  insert into private.idea_image_moderation_queue(idea_id,user_id,school_id,image_path)
  values(p_idea_id,p_user_id,p_school_id,p_image_path);
  return true;
end;$function$;

create or replace function public.claim_idea_image_moderation_tasks(p_limit integer default 1,p_lease_seconds integer default 120)
returns table(queue_id uuid,idea_id uuid,user_id uuid,school_id text,image_path text,attempts integer,idea_text text)
language plpgsql security definer set search_path=pg_catalog,public,private as $function$
begin
 return query with picked as (
   select q.id from private.idea_image_moderation_queue q
   join public.ideas i on i.id=q.idea_id and i.ai_status='pending'
   where ((q.status in('queued','retry') and q.next_attempt_at<=now()) or(q.status='processing' and q.locked_until<now()))
   order by q.next_attempt_at,q.created_at for update of q skip locked
   limit greatest(1,least(coalesce(p_limit,1),4))
 ), claimed as (
   update private.idea_image_moderation_queue q set status='processing',attempts=q.attempts+1,
     locked_until=now()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,120),300))),updated_at=now()
   from picked where q.id=picked.id returning q.*
 )
 select c.id,c.idea_id,c.user_id,c.school_id,c.image_path,c.attempts,i.text from claimed c
 join public.ideas i on i.id=c.idea_id and i.ai_status='pending';
end;$function$;

create or replace function public.finish_idea_image_moderation_task(
 p_queue_id uuid,p_state text,p_reason_code text default null,p_reason text default null,p_retry_seconds integer default null
) returns boolean language plpgsql security definer set search_path=pg_catalog,public,private as $function$
declare v_idea_id uuid;v_image_path text;v_remaining integer;v_pending integer;
begin
 if p_state not in('approved','rejected','retry','manual_review','failed') then
   raise exception 'invalid_idea_image_moderation_state' using errcode='22023';
 end if;
 select q.idea_id,q.image_path into v_idea_id,v_image_path from private.idea_image_moderation_queue q where q.id=p_queue_id for update;
 if v_idea_id is null then return false; end if;
 if p_state='rejected' then
   update public.ideas set image_paths=array_remove(image_paths,v_image_path),
     ai_reason=coalesce(nullif(p_reason,''),'Фото не прошло проверку безопасности.')
   where id=v_idea_id and ai_status='pending';
 elsif p_state='manual_review' then
   update public.ideas set ai_reason='Фото сохранено приватно и ожидает проверки Совета.'
   where id=v_idea_id and ai_status='pending';
 elsif p_state='failed' then
   update public.ideas set image_paths=array_remove(image_paths,v_image_path),
     ai_reason='Не удалось проверить фото; оно удалено из предложения.'
   where id=v_idea_id and ai_status='pending';
 elsif p_state='retry' then
   update public.ideas set ai_reason='Фото сохранено приватно; проверка будет повторена автоматически.'
   where id=v_idea_id and ai_status='pending';
 else
   update public.ideas set ai_reason='Фото прошло автоматическую проверку.'
   where id=v_idea_id and ai_status='pending';
 end if;
 select cardinality(image_paths) into v_remaining from public.ideas where id=v_idea_id;
 select count(*) into v_pending from private.idea_image_moderation_queue
   where idea_id=v_idea_id and id<>p_queue_id and status in('queued','processing','retry');
 if coalesce(v_remaining,0)=0 then
   update public.ideas set ai_status='approved' where id=v_idea_id and ai_status='pending';
 elsif p_state='approved' and coalesce(v_pending,0)=0 then
   update public.ideas set ai_status='approved' where id=v_idea_id and ai_status='pending';
 end if;
 update private.idea_image_moderation_queue set status=p_state,
   next_attempt_at=case when p_state='retry' then now()+make_interval(secs=>greatest(300,least(coalesce(p_retry_seconds,3600),604800))) else next_attempt_at end,
   locked_until=null,last_reason_code=left(coalesce(p_reason_code,''),80),
   last_reason=left(coalesce(p_reason,''),180),updated_at=now() where id=p_queue_id;
 return true;
end;$function$;

revoke all on function public.enqueue_idea_image_moderation_task(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.claim_idea_image_moderation_tasks(integer,integer) from public,anon,authenticated;
revoke all on function public.finish_idea_image_moderation_task(uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.enqueue_idea_image_moderation_task(uuid,uuid,text,text) to service_role;
grant execute on function public.claim_idea_image_moderation_tasks(integer,integer) to service_role;
grant execute on function public.finish_idea_image_moderation_task(uuid,text,text,text,integer) to service_role;
commit;
