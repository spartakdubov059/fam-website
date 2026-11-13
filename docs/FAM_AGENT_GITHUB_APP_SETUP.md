# Подключение GitHub App для FAM Agent PR

Этот App позволяет draft PR, созданному FAM workflow, автоматически запускать PR workflow-проверки. Без него текущий fallback через `GITHUB_TOKEN` может потребовать ручного разрешения на запуск Actions. App не получает admin-, Actions-, secrets- или deployment-прав. Однако `Contents: write` необходимо для push agent branch и это разрешение также позволяет вызывать Merge Pull Request API; нельзя считать, что App технически не способен выполнить merge.

## Создать App

1. В настройках GitHub аккаунта `spartakdubov059` создай GitHub App с именем, например, `FAM Agent PR Manager`.
2. Отключи webhook: App не принимает входящие события.
3. Выдай только права репозитория:
   - Contents — Read and write
   - Pull requests — Read and write
   - Checks — Read-only
4. Установи App только на репозиторий `fam-website`.
5. Сохрани Client ID в repository variable `FAM_GITHUB_APP_CLIENT_ID`.
6. Создай private key и сохрани его только в repository secret `FAM_GITHUB_APP_PRIVATE_KEY`. Не добавляй ключ в репозиторий, issue, PR или чат.

Workflow запрашивает installation token только для `fam-website` и только с `contents:write`, `pull-requests:write`, `checks:read`. GitHub не предоставляет отдельного `Contents:write` без Merge Pull Request API: merge защищается правилами ветки, а не ограничением этого токена.

## Обязательная защита main

Перед настройкой App в активном ruleset `FAM — защита main` должно быть выставлено минимум 1 approving review, dismiss stale approvals on new commits и отсутствие bypass actors. На read-only снимке 13 ноября 2026 в 14:10 UTC ruleset требовал 0 approvals, хотя PR и Russian content safety check были обязательными. Поэтому workflow owner-gate — дополнительная защита для веток `codex/fam-run-*`, но не замена нативному запрету merge без review; также не защищает от изменений самого gate-workflow вне coder allowlist.

Эту настройку в GitHub не менял. Не устанавливай App token для FAM Agent, пока нативное правило одобрения не включено и не проверено.

## Проверить после настройки

После review/merge PR #65 и добавления variable/secret:

1. Запусти одну безопасную синтетическую задачу, которая изменяет только отдельный файл в `docs/`.
2. Убедись, что отчёт указывает `CI trigger: scoped GitHub App token`, PR остаётся draft, а required CI действительно запускается без ручного Approve workflows.
3. Убедись, что owner approval check завершился ошибкой до актуального review владельца и проходит после approval текущего head SHA.
4. Проверь, что ни одна проверка не объединяет PR и не запускает production deploy. После сценария оставь тестовый PR draft или закрой его без merge.

До успешного сквозного сценария App-интеграция считается подготовленной в коде, но не проверенной runtime.
