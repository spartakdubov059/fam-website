# FAM RU system-health check

`npm run check:system` produces a read-only, manual system-health report for the isolated Russian backend.

It combines:

- the local runtime readiness endpoint (Yandex auth configuration, YDB and object storage);
- the allowlisted FAM RU `systemd` timers, including recent service result and freshness;
- aggregate counts for the daily-report and site-error-digest queues, including expired leases and recent failures.

The output contains only service flags, timer unit names, queue counts and the count of required RU tables with zero-row `SELECT` probes. It does not include task payloads, user records, object keys, or timestamps. The checker does not enqueue or execute work. It closes the runtime after reading the aggregates and exits nonzero when a check is missing or unhealthy.

Run from `ru-migration/app/backend` on the Russian staging host:

```sh
npm run check:system
```

The check requires a configured staging runtime and active timers to report healthy. On a local machine without `systemd` or staging credentials, a degraded result is expected. The RU schema probe checks zero-row read access to all 36 fixed tables; it does not read their rows, verify write grants or inspect YDB ACL catalogs. It remains a limited RU operational analogue: it does not verify source-only Supabase extensions, `pg_cron`, or RPC definitions and does not establish full parity with the source `fam-agent-worker` health report. Scheduling remains a separate deployment decision and is not enabled by this command.
