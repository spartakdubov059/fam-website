# FAM safe database queue worker

## What runs automatically

- At 06:05 UTC each day, PostgreSQL queues one technical health-check task.
- Every five minutes, pg_cron invokes the internal database worker.
- The worker only claims quality / queue_health_check tasks with approval_required = false.
- It stores a short result with queue status counts and a minimal event trail.

## Safety boundaries

- The worker never reads profile, listing, message, deletion-request or image content.
- It never changes a participant account, listing, role, suspension or private message.
- It does not approve or reject analyst proposals.
- Unknown task types and tasks requiring approval remain queued.
- A unique daily schedule key prevents duplicate scheduled health checks.
- The functions are in the private schema and executable only by postgres.

## Not a general AI agent

This is a database-side scheduled worker for one safe technical task. It is not an LLM and does not implement the full technical, moderation, safety, database or growth agents. The separate Edge Function fam-agent-worker retains its own authenticated allowlist; this migration does not expose it or store its token in PostgreSQL.
