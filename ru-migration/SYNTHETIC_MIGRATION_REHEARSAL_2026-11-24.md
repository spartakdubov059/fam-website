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
