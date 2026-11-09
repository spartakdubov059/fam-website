# Исполнитель очереди ИИ-агентов FAM — проект безопасного запуска

Статус: подготовлено в GitHub-ветке для проверки. Не развёрнуто и не включено в расписание.

## Что добавлено

- `supabase/functions/fam-agent-worker/index.ts` — закрытый исполнитель с отдельным секретом `FAM_AGENT_WORKER_TOKEN`.
- Функция не вызывает OpenAI и не читает объявления, переписки, email или профили.
- В первой версии разрешён только один тип задания: `quality / queue_health_check`.
- Пакет ограничен пятью заданиями за один запуск; срок аренды — 120 секунд.
- Любой неизвестный тип задания блокируется, а не выполняется.
- Если секреты не настроены, функция завершает запрос с ошибкой конфигурации.
- Ответ содержит только количество обработанных заданий.

## Требуемая серверная миграция (пока НЕ применена)

Исполнитель использует две ограниченные RPC-функции. Их нужно добавить отдельной миграцией после проверки SQL и advisors.

```sql
create or replace function public.claim_fam_agent_tasks(
  p_worker_id text,
  p_limit integer default 3,
  p_lease_seconds integer default 120
)
returns table (
  id uuid,
  agent_key text,
  task_type text,
  approval_required boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) not between 1 and 80 then
    raise exception 'invalid worker id';
  end if;

  with exhausted as (
    update private.fam_agent_tasks as t
    set status = 'failed',
        result_summary = 'Задача остановлена после исчерпания попыток.',
        claimed_by = null,
        lease_expires_at = null,
        finished_at = now(),
        updated_at = now()
    where t.status in ('claimed', 'in_progress')
      and t.lease_expires_at < now()
      and t.attempt_count >= t.max_attempts
    returning t.id
  )
  insert into private.fam_agent_task_events (task_id, event_type, actor, summary)
  select e.id, 'failed', p_worker_id, 'Задача остановлена после исчерпания попыток.'
  from exhausted;

  return query
  with candidates as (
    select t.id
    from private.fam_agent_tasks as t
    where t.approval_required = false
      and t.agent_key = 'quality'
      and t.task_type = 'queue_health_check'
      and t.available_at <= now()
      and t.attempt_count < t.max_attempts
      and (
        t.status = 'queued'
        or (t.status in ('claimed', 'in_progress') and t.lease_expires_at < now())
      )
    order by
      case t.priority
        when 'urgent' then 0
        when 'high' then 1
        when 'normal' then 2
        else 3
      end,
      t.created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 5)
  ), claimed as (
    update private.fam_agent_tasks as t
    set status = 'claimed',
        claimed_by = p_worker_id,
        claimed_at = now(),
        lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 300)),
        attempt_count = t.attempt_count + 1,
        updated_at = now()
    from candidates as c
    where t.id = c.id
    returning t.id, t.agent_key, t.task_type, t.approval_required
  ), logged as (
    insert into private.fam_agent_task_events (task_id, event_type, actor, summary)
    select c.id, 'claimed', p_worker_id, 'Задание передано безопасному исполнителю.'
    from claimed as c
    returning task_id
  )
  select c.id, c.agent_key, c.task_type, c.approval_required
  from claimed as c
  join logged as l on l.task_id = c.id;
end;
$$;

create or replace function public.finish_fam_agent_task(
  p_task_id uuid,
  p_worker_id text,
  p_status text,
  p_summary text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task_id uuid;
  v_event_type text;
  v_summary text;
begin
  if p_status is null or p_status not in ('completed', 'blocked', 'failed') then
    raise exception 'invalid task status';
  end if;

  v_event_type := p_status;
  v_summary := left(coalesce(nullif(btrim(p_summary), ''), 'Задача обработана.'), 1000);

  update private.fam_agent_tasks as t
  set status = p_status,
      result_summary = v_summary,
      claimed_by = null,
      lease_expires_at = null,
      finished_at = case when p_status in ('completed', 'failed') then now() else null end,
      updated_at = now()
  where t.id = p_task_id
    and t.claimed_by = p_worker_id
    and t.status = 'claimed'
    and t.lease_expires_at > now()
  returning t.id into v_task_id;

  if v_task_id is null then
    return false;
  end if;

  insert into private.fam_agent_task_events (task_id, event_type, actor, summary)
  values (v_task_id, v_event_type, p_worker_id, v_summary);

  return true;
end;
$$;

revoke all on function public.claim_fam_agent_tasks(text, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_fam_agent_task(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_fam_agent_tasks(text, integer, integer) to service_role;
grant execute on function public.finish_fam_agent_task(uuid, text, text, text) to service_role;
```

## Условия перед включением

1. Создать миграцию штатной командой Supabase CLI, проверить её и выполнить advisors.
2. Применить миграцию только после отдельной проверки безопасности.
3. Настроить `FAM_AGENT_WORKER_TOKEN` в Edge Function Secrets; само значение не записывать в GitHub и не отправлять в чат.
4. Развернуть функцию с `verify_jwt=false` только потому, что внутри включена собственная проверка отдельного длинного секрета. Без секрета endpoint отвечает 503.
5. Отдельно настроить расписание. Сейчас в проекте есть действующее задание `hide-old-listings`; его не менять.
6. Сначала вручную проверить только тестовое задание `queue_health_check`, затем включать расписание.
7. Не добавлять OpenAI-запросы, автопубликацию, изменения RLS, удаление данных или production-деплой в эту первую версию.

## Ограничения

Это не полноценная система автономных ИИ-агентов. Это минимальный исполнитель очереди для безопасной проверки механизма. Для аналитики и реальных специализированных задач нужны отдельные обработчики, лимиты расходов, тесты и отдельные разрешения.
