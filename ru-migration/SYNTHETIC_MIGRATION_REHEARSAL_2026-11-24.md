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

## Synthetic payload equality

Commit `03f044cd59585c19eb4772d65bcdbbe62b298bbc` passed all three CI workflows (655 backend tests reported in prior iteration). Added separate offline payload comparison for synthetic listing titles/descriptions, idea bodies, approved/pending message bodies and canonical timestamps, with complete coverage of structural IDs. Nine new test cases; CI required. This is not a production schema mapping or full payload migration; votes, events, additional fields and actual media remain open.

## Payload timestamp regression fix

Commit `c0560018f0fd599c5d904b292dc1c249f5cc8fd0` failed 6 of 664 backend tests ([CI](https://github.com/spartakdubov059/fam-website/actions/runs/45417786035)): a double-escaped decimal separator rejected canonical timestamps before payload comparison. Corrected the literal dot and added negative separator cases on both sides. Existing canonical date and payload checks remain intact. New CI required; no production change.

## School activity reconciliation

Baseline `2a1db5308b620f345d41f38275b3cf36aec73bd9` passed 665/665 backend tests, 180/180 moderation tests and disposable YDB including immutable profile staging. Added a separate synthetic-only comparison for event fields (complete listing coverage), registrations and occupancy, school announcements, polls including option order, and individual votes. It checks primary keys, school scope, referenced records, bounded counts and canonical synthetic dates. It does not establish source inventory completeness for standalone tables or implement production ETL; both source and target must be independently extracted in future. Inconsistent historical rows are review blockers, not instructions to erase or rewrite records. 25 regression cases added; current CI must pass.

## Combined synthetic acceptance

Baseline `e5489935d9bedd13a699a47d63b960ec7ba2d2d7`: 690/690 backend tests, all three CI checks passed ([SDK](https://github.com/spartakdubov059/fam-website/actions/runs/45478331769), [YDB](https://github.com/spartakdubov059/fam-website/actions/runs/45478331663), [moderation](https://github.com/spartakdubov059/fam-website/actions/runs/45478331582)). The combined offline acceptance checker now requires accounts, structural data, attachment manifests, covered payloads and school activity on all three snapshots. It rejects missing sections, mismatched snapshots and corruption on target or restored side. 17 additional tests. Existing v1 backup envelope remains limited to core metadata; a full versioned backup of these extended sections and actual isolated database restore are still required. This is a normalized synthetic rehearsal, not actual extraction or a live cutover authorization. New CI required.

## Full versioned synthetic archive

Baseline `2efdf03782aeeb31029027d4d7e35e747cbfe511`: [SDK CI](https://github.com/spartakdubov059/fam-website/actions/runs/45479178904) passed 707/707 backend tests, [YDB](https://github.com/spartakdubov059/fam-website/actions/runs/45479179208) and [moderation](https://github.com/spartakdubov059/fam-website/actions/runs/45479178884) passed. Added separate v2 archive with mandatory full normalized snapshot and synthetic attachment byte payloads, size limits, exact object coverage and independent SHA-256 verification; v1 remains unchanged and cannot be mistaken for v2. New tests cover serialized disk restore and corruption. The byte payloads are explicitly dummy strings, not real photos. The archive is not encrypted or an authenticated database dump; actual database restoration, complete source schema coverage, true provider proof and approved infrastructure remain open. 13 new cases; new CI required.

## Disposable database archive restore

Baseline `66609a41f1b03f991a3c61a9c67e5a28c52710d0`: 720/720 backend tests and moderation passed. Added a hard-coded synthetic archive restore rehearsal using the actual disposable YDB profile, listing, approved message, pending message, event registration and occupancy tables. The test builds and decodes a v2 archive locally, restores these six tables in one transaction, re-reads selected covered fields, verifies the combined reconciliation, simulates interruption and exact replay, and refuses divergent replay. Noncovered sections must be empty; fixed defaults for noncovered columns are explicitly fixture-only. This is not an arbitrary restore API, production database dump or coverage of real user identities, poll/announcement TTL, actual photo bytes, or all profile/metadata fields. New CI required.

### Restore rehearsal: SDK error handling

Commit `192258ea70d6d7917314d23aca5dde030fa1cf0f` passed backend and moderation, but [disposable YDB CI](https://github.com/spartakdubov059/fam-website/actions/runs/45480480717) failed at the new restore test: the intended interruption was reached, then the pinned query SDK wrapped the original exception in `Error("Transaction failed.")` with its original cause. Updated both rejection assertions to verify the specific nested cause (the injected interruption or the reconciliation assertion). All database rollback, no-overwrite and equality assertions remain intact. Re-run required; the original failed run did not prove rollback or replay completion.

## Eleven-table disposable restoration

Baseline `05052206459cea433c98ffa00a88228be3f1e3bf` passed all three CI checks, with [YDB restore](https://github.com/spartakdubov059/fam-website/actions/runs/45480776720) logging YDB_SYNTHETIC_RESTORE_PASS for six tables. Extended the fixed local fixture to restore ideas, favorites, announcements, polls and votes in the same transaction. Added vote-conflict refusal and late interruption after all writes. School activity allows explicitly bounded far-future synthetic pulse dates solely to keep TTL fixtures alive across future CI runs; actual retention rules are unchanged. Noncovered profile and status columns and favorite timestamp use explicit synthetic defaults; no real import or TTL policy migration is claimed. New CI required.

### Account-role validation hardening

The synthetic account comparison previously accepted arbitrary lowercase role identifiers if both snapshots matched. Restricted it to the three roles already accepted by the legacy-profile mapper. Ten negative cases cover unknown roles on either side, including matching invalid source/target roles. This is only a verifier change; no live account authority or policy changed. New CI required.

## Private attachment staging and thirteen-table restore

Baseline `dab309d6759079edc6e5ca3db5a32bbef0910712` passed 731/731 backend tests, moderation and [disposable YDB restore of eleven tables](https://github.com/spartakdubov059/fam-website/actions/runs/45481942953). Extended the fixed fixture to restore media ownership rows and idea-image links, with three dummy object payloads including two ordered idea images. Local private files are written exclusively, read back and hash checked before any DB writes. Missing or corrupt objects block restore; all thirteen database tables roll back on injected failure. Replay verifies object hashes, linked ownership and fixture moderation state and refuses changed bytes or changed idea-image review state. Files are staged separately from the database and cleaned in finally; this is NOT a distributed S3/YDB transaction, real WebP backup, real-user export or full production importer. Status columns still use explicit fixture-only values. New CI required.

## Version 3 archive: covered record state preservation

The previous restore used fixed values for several non-core columns, including an idea admin status not supported by the real workflow. Added a strict synthetic state section covering listing category/price/moderation, idea review and summary/reason, read flags, favorite timestamps, media state and timestamps, and idea-image timestamps. The v3 archive wraps the unchanged v2 archive and includes this section in the outer checksum; a v2 archive cannot be silently read as v3. The thirteen-table disposable rehearsal now writes these values from the decoded archive, checks them against independently re-read rows, and refuses changed read flags or review state. Unknown states and unresolved deletion leases fail closed. 17 new unit cases. Still a fixed synthetic rehearsal, not a full source schema export, distributed object storage transaction, or production authorization. New CI required.

## Version 4 profile details and source-schema check

Baseline `a5e6e5bf06f9b88f53dfaf4486d3e8f82ec8de67` passed 748/748 backend tests, 180/180 moderation tests and [YDB restore](https://github.com/spartakdubov059/fam-website/actions/runs/45486065227). Reviewed source SQL migrations 20261114090000, 20261116120000 and 20261117100000: original profile ID, school and authority must be separately preserved; descriptive participant types and staff review state must not confer account roles. Added v4 archive and exact comparison of profile details with mandatory per-account coverage and null/empty distinction. The fixed disposable YDB restore writes these values from the archive and checks student, staff and parent records plus divergent staff-review replay. Twenty new unit cases. Nonempty avatar URLs remain explicit blockers; no actual profile export, derivation of legacy active status, real provider verification, actual avatar storage mapping or cutover is authorized. New CI required.

## Generated WebP legacy-avatar rehearsal

Baseline `37bcce3a66ccc7b481688f77d711b381f05a3f86`: [SDK](https://github.com/spartakdubov059/fam-website/actions/runs/45624593311) 768/768, [YDB](https://github.com/spartakdubov059/fam-website/actions/runs/45624593353) confirmed profile fields and 13-table restoration, moderation passed. Added a separate fixed synthetic avatar rehearsal with actual generated JPEG converted to WebP, independent private file backup, owner-scoped target key, exact SHA-256 byte comparison, missing/corrupt/conflicting copy refusal, and the existing YDB avatar-review and media access flow. An imported image must remain unpublished until separately authorized review; cross-school and anonymous access are refused. After approval only the current owner can retrieve the image. The storage adapter is injected/local; no network or real avatar URLs are used. This does not resolve historical avatar URL mapping, review provenance, cloud copy, or full v4 archive coverage. New CI required.

## Staged profile digest revalidation at account linking

The isolated account-link repository previously checked the stored profile_version and field validity, without recomputing the version from the selected columns. It now uses the same synthetic profile preparation function as staging and compares the recomputed canonical digest within the link transaction. Updated earlier integration fixtures to use authentic synthetic digests rather than placeholder strings. Added role, class and null/empty tamper scenarios (individually valid values), verifying no account or ledger write, no consumed challenge and exact retry after restoring the original fields. This deliberately restricts the prototype to reserved synthetic UUIDs; production authorization, trusted snapshot signing and real identity adapters remain unresolved. New CI required.

## Independent inventory acceptance

The v4 equality rehearsal cannot detect a record omitted from every input snapshot. Added a separate mandatory-for-this-check independent count inventory over thirteen normalized table groups, tied to the same synthetic snapshot ID, validating exact table coverage and bounded integer counts. Thirteen cases cover shared omission, wrong snapshot, invalid counts and preservation of existing reconciliation checks. Counts must ultimately be obtained from a consistent, independently authorized source extraction; fixture constants are not a production inventory, and equal counts alone cannot establish correct row selection. No source database access or production changes. New CI required.

### Inventory integration and CI checkout diagnostics

Integrated the explicit independent fixture inventory into the existing thirteen-table YDB restore reconciliation. The earlier failed SDK package HTTP smoke test returned 503 instead of 200; YDB logs reported a syntax error on line 1 of ydb-listings.mjs showing a truncation warning as source. A bounded failed-job retry reproduced the YDB error, but repository reads report the same blob SHA `67d9c79753cda5f01b30cf910eaff77a38f6a38b` on the last green and failing commits and a valid first line. Do not replace the large repository module with a partial fetch. Both CI workflows now preflight the checked-out repository blob against the checked-out commit and syntax-check tracked backend/compat modules before installing dependencies or packaging. This is diagnostic instrumentation, not a claimed fix of an unverified cause; no checks are relaxed. Prior generated WebP test did pass on commit 778f86c ([YDB](https://github.com/spartakdubov059/fam-website/actions/runs/45625254456)). Current full CI still required.

## Synthetic migration runner and infrastructure inspector

Added `compat/synthetic-migration-runner.mjs` to produce a versioned offline migration package only after source/target/restored acceptance and independent inventory checks pass. The runner rejects non-synthetic snapshot IDs, snapshot mismatches, invalid complete snapshots and live-cutover authorization remains permanently false. This is an executable rehearsal boundary, not a production exporter or importer.

Added the bounded FAM agent-team policy to represent the existing coordinator, developer, tester, security reviewer, analyst, documentator and Russian-interface roles. It rejects shell/tool fields and permits at most one model-enabled role; no prompt, secret or raw user payload can be stored in the policy task.

Ported the bounded infrastructure INSPECTOR signal path to YDB: allowlisted signal codes, event-ID/digest deduplication, seven-day cooldown, no raw logs, a one-active-coder-task guard and an infrastructure-only coder task payload. The authenticated coder bridge exposes `inspector_enqueue` only to the same strong worker-token boundary and does not enable Qwen execution, shell tools or PR creation.

### Independent runner acceptance and CI coverage

The newly added offline runner previously reused source state/profile arrays for both target and restored comparisons, masking differences. Require independently supplied state/profile sections for each side, preserve rejection stage/table, bind the independent inventory digest into the plan and derive table count from the verifier. Added eight regression cases and explicitly run the compat runner tests in SDK CI (the backend test glob does not discover them). This is still offline synthetic acceptance, not a real importer. Latest prior two commits were not yet verified by CI at inspection. No production access.
