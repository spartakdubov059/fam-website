# Offline synthetic migration rehearsal — 2026-11-24

Scope: structural checks only, using intentionally synthetic IDs and a fake identity issuer. No production access, student records, exports, cloud calls or identity linking.

- `compat/verify-synthetic-account-rehearsal.mjs`: compares synthetic source and target profile manifests, preserving internal ID, school, role and active state; detects missing, extra or duplicate profiles and duplicate target identity subjects.
- `compat/verify-synthetic-content-rehearsal.mjs`: checks normalized synthetic metadata for profiles, listings, ideas, approved/pending messages, favorites, media and idea images. Detects duplicate keys, missing references, ownership and school-scope violations, and collisions between pending and approved messages.
- Regression suites live under `app/backend/test/`. The corresponding 12 account and 16 content cases were exercised in an isolated JavaScript runtime before publication. The full pinned Node/YDB GitHub CI is still required.

The content check is not a source/target equality comparison. It deliberately flags historical orphan references for review; it does not authorize deleting or rewriting them. It is not an exporter, importer, database constraint, backup or verification of actual identity ownership. It cannot confirm preserved text, timestamps, attachment bytes, votes, event records, or production access controls.

Before a real migration:
1. Approve a lawful, access-controlled data handling plan with the school and authorized operators, including retention, rollback and the target Russian environment.
2. Establish a verified dual-authentication account-linking flow: ownership of the existing account and the new provider identity must be independently proven. Never match by name, email alone or school/class. Keep unresolved accounts locked against reassignment. Do not store provider passwords or tokens in migration manifests.
3. Build isolated source-to-target count and field reconciliation plus attachment integrity checks using synthetic fixtures first. Resolve orphan records explicitly; never silently drop rows.
4. Verify cloud IAM, real authentication, backup restore, school-scoped authorization and cutover/rollback in an approved non-production environment. No real pupil data until all gates pass.
5. Keep `main`, production, personal server and paid resources untouched. No live cutover or data export is authorized by this rehearsal.

## Extended rehearsal — 24 November

- PR commit `3beae59197628ea9b65522ba7ce25491e66e8e61`: the pinned backend suite passed **625/625** ([SDK CI](https://github.com/spartakdubov059/fam-website/actions/runs/45398129523)); [disposable YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/45398129599) confirmed atomic account linking, collision rejection, rollback and retry, and removed the test database. The separate legacy moderation workflow failed; full PR CI is not green.
- The account link prototype is not wired to HTTP or real identity providers. It requires independently verified legacy and Yandex proofs, preserves UUID and profile authority, refuses ambiguous profile fields and uses a serializable YDB transaction in the disposable test only.
- `verify-synthetic-cutover-rehearsal.mjs` combines source/target and restored-source/target comparisons and attachment digests. It deliberately returns `live_cutover_authorized: false`. A supplied restored manifest is not evidence of an actual backup restore. Full payload/timestamp equality, real object bytes, unlinked account handling and actual restore remain open.
- The extended disposable integration test covers two distinct legacy UUIDs racing for one identity, and inactive/suspended profiles. New CI must pass before these scenarios are considered verified.

## Serialized synthetic backup rehearsal

The previous commit `5f50355dfcb68e97bfe36854a123730ee448c248` passed SDK and disposable YDB CI ([SDK](https://github.com/spartakdubov059/fam-website/actions/runs/45400917033), [YDB](https://github.com/spartakdubov059/fam-website/actions/runs/45400916908)). The new version adds an offline, bounded, versioned synthetic backup envelope with independent SHA-256 verification and a temporary-file round-trip test including synthetic attachment bytes. This is not a production backup, YDB dump, authenticated archive, encryption, or proof of cloud restore. It does not authorize a live cutover. The branch-only moderation change removes four provider-outage codes from cached user conduct signals; pending decisions and actual harmful-content signals remain unchanged. This deliberately changes the upstream reference file on this PR, so source parity must be rechecked before merge. No main/production update.

## Immutable synthetic profile staging

Previous PR commit `fb8458b1d050624bc220652f2bbbf454348c4293` passed 648/648 backend tests, disposable YDB and moderation ([SDK](https://github.com/spartakdubov059/fam-website/actions/runs/45404262916), [YDB](https://github.com/spartakdubov059/fam-website/actions/runs/45404263231), [moderation](https://github.com/spartakdubov059/fam-website/actions/runs/45404263087)). The next change adds a bounded synthetic-only profile batch writer with deterministic version digests, no overwrites, exact replays, immutable roles and activity, and transaction rollback. It rejects non-rehearsal UUIDs/names and remains isolated in compat. New CI must pass. This is not the approved real importer; source eligibility, authorization, media migration, and real identity verification remain open.
