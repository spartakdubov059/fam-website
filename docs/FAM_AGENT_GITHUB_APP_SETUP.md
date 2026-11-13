# Подключение GitHub App для FAM Agent PR

Этот App позволяет draft PR, созданному FAM workflow, автоматически запускать PR workflow-проверки. Без него текущий fallback через `GITHUB_TOKEN` может потребовать ручного разрешения на запуск Actions. App не получает права на merge, production, Actions, секреты или настройки репозитория.

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

Workflow запрашивает installation token только для `fam-website` и только с `contents:write`, `pull-requests:write`, `checks:read`. Установка App должна включать эти же разрешения; если конфигурация неполная, шаг получения токена завершится ошибкой.

## Проверить после настройки

После review/merge PR #65 и добавления variable/secret:

1. Запусти одну безопасную синтетическую задачу, которая изменяет только отдельный файл в `docs/`.
2. Убедись, что отчёт указывает `CI trigger: scoped GitHub App token`, PR остаётся draft, а required CI действительно запускается без ручного Approve workflows.
3. Убедись, что owner approval check завершился ошибкой до актуального review владельца и проходит после approval текущего head SHA.
4. Проверь, что ни одна проверка не объединяет PR и не запускает production deploy. После сценария оставь тестовый PR draft или закрой его без merge.

До успешного сквозного сценария App-интеграция считается подготовленной в коде, но не проверенной runtime.
