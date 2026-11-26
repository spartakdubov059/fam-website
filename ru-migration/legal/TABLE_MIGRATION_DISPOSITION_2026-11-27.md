# FAM RU — table disposition review (27.11.2026)

Offline planning only. Not source-to-target schema equivalence, not an approved migration, not a database importer, and not evidence of compliance. Checked 38 schema files in the current local-YDB workflow. The test compares all CREATE TABLE declarations in the schema directory against the 40-entry batch catalog and this disposition policy; new/unknown/duplicate tables fail closed. The separate legacy-account-link rehearsal schema is outside this production-target table catalog and must not be deployed automatically.

Categories:
- retain_reviewed: carry only necessary, authorized records with original dates, content, scope and access restrictions.
- derive: rebuild from verified primary records and check consistency.
- reauthorize: invalidate prior auth artifacts and use a fresh independently verified process.
- reconcile: operator-approved field mapping, incomplete workflow and relationship checks before any transfer.
- restart_controlled: reconcile safe operation history, invalidate old leases, restart under explicit authority only; never replay old work blindly.

All actions remain proposals. Actual source schema, independently verified export, lawful basis and retention, source/target relationships, completeness, role checks and legal gate remain mandatory. No deletion or retention extension is authorized by this policy. Preserve legal deadlines; no arbitrary date reset. Do not send real data to GitHub or external AI. Technical TTL values are not legal conclusions. Do not blindly import records, nor blindly discard safety records. If a dependency is unresolved, fail closed for the affected operation. The cutover gate continues to reject all real authorization attempts in this offline rehearsal.

| Table | Proposed disposition | Required evidence/review |
|---|---|---|
| fam_account_deletion_jobs | reconcile | Identities and durable deletion intent; reconcile pending operations under approved retention/deletion deadlines, keep account inactive, issue new lease only after object inventory; never copy claim token or old OAuth subject. |
| fam_account_deletion_open | derive | Rebuild unique open-request index from reconciled requests; reject multiple open requests and conflicting school/target. |
| fam_account_deletion_requests | reconcile | Preserve necessary review and pending status, original timestamps and links; reconcile processing state and lawful deletion deadlines; no accidental reactivation. |
| fam_account_suspension_audit | retain_reviewed | Keep justified administrative history with original timestamps, minimization and restricted school/operator access. |
| fam_account_suspension_open | derive | Derive from unexpired, unlifted restrictions after reconciliation; no suspended account may become active during import. |
| fam_account_suspensions | reconcile | Preserve valid active restrictions and lawful history; retain issue/lift/expiry fields; reject contradictions and check identity/school links. |
| fam_agent_daily_digest_tasks | restart_controlled | Do not copy live leases or retry tokens; reconcile pending work and regenerate safe aggregate jobs without double execution. |
| fam_agent_daily_reports | retain_reviewed | Only necessary aggregate reports after content and retention review; no student identifiers, raw prompts or model output. |
| fam_agent_ideas | retain_reviewed | Review necessary suggestion history and human decisions; minimize notes and reviewer identity; no automatic action or publication. |
| fam_agent_inspector_signals | restart_controlled | Reconcile deduplication and cooldown state against approved sanitized event ledger; don't blindly replay old signals or task IDs. |
| fam_agent_school_daily_reports | retain_reviewed | Only approved aggregate school reports after minimization and small-group disclosure review. |
| fam_agent_task_events | retain_reviewed | Preserve necessary sanitized terminal audit evidence under original TTL; reject secrets, arbitrary summaries and pupil data. |
| fam_agent_tasks | restart_controlled | Do not resume legacy tasks or copy claims, prompts, payloads or permissions automatically; independently approve safe work and reconcile old execution. |
| fam_avatar_reviews | reconcile | Preserve necessary review state only after private object reconciliation and verified owner/school links; no implicit approval. |
| fam_event_occupancy | derive | Recompute from eligible registrations and event capacity; compare against source count and investigate discrepancies. |
| fam_event_registrations | retain_reviewed | Preserve eligible registration status, event/user/school links and timestamps; check capacity and duplicates. |
| fam_favorites | retain_reviewed | Preserve lawful user/listing links with timestamps and same-school scope; do not resurrect deleted targets. |
| fam_idea_images | retain_reviewed | Copy only lawful private objects with independent byte hashes, ownership, review state and exact idea links. |
| fam_ideas | retain_reviewed | Preserve necessary private content, review state and original timestamps; no visibility expansion or foreign moderation. |
| fam_initial_school_admin_bootstrap | reconcile | Preserve verified bootstrap history or fail closed until authorized operator establishes marker; never reset to permit another first-admin grant. |
| fam_listings | retain_reviewed | Preserve eligible listing content, event fields, state, owner and school; independently reconcile private media. |
| fam_messages | retain_reviewed | Only if chat has approved legal basis and retention; preserve exact read state, participants, listing, school and timestamps; no external AI. |
| fam_notification_reads | retain_reviewed | Preserve actual read markers only, under original TTL; never convert unread notifications into read markers. |
| fam_pending_media | reconcile | Reconcile private object inventory and owner/status/expiry; no legacy claim token or lease; restrict stale/orphaned media. |
| fam_pending_messages | retain_reviewed | If chat is authorized, preserve necessary pending review rows privately without delivery or auto-approval; original timestamps. |
| fam_profile_requests | reconcile | Pending school membership review tied to independently verified identity; minimize expired/closed personal fields; preserve TTL; never auto-approve. |
| fam_role_email_verifications | reauthorize | Never import old email/code digests or verified state; reverify with target provider and fresh secret under authorized procedure. |
| fam_safety_incidents | retain_reviewed | Necessary minimized school-scoped evidence only, original 90-day TTL unless lawful reviewed exception; no raw chats or uncontrolled external access. |
| fam_school_admin_audit | retain_reviewed | Preserve necessary role-change evidence with actual actor/target, school and original timestamps; restricted access. |
| fam_school_announcements | retain_reviewed | Preserve eligible notices with original publication and expiry dates; never republish expired content. |
| fam_school_content_audit | retain_reviewed | Preserve justified moderation history; sanitize details and preserve scope/retention; do not expose to students. |
| fam_school_poll_votes | retain_reviewed | Preserve eligible votes, unique voter/poll and valid choice, original TTL; no voting identity exposure. |
| fam_school_polls | retain_reviewed | Preserve eligible polls/options/closure timestamps; no reopening, reconcile referenced votes. |
| fam_school_role_request_audit | retain_reviewed | Preserve necessary immutable review transitions and school links; original timestamps and limited access. |
| fam_school_role_requests | reconcile | Map verified identity, preserve pending/terminal status and review history; revalidate privileges; no automatic grant. |
| fam_site_error_counts | restart_controlled | Regenerate allowlisted counters in target; no raw request logs; if retaining historical aggregate metrics, review separately with original TTL. |
| fam_site_error_digest_tasks | restart_controlled | Start fresh after reconciling schedules; no active claims, retry tokens or duplicate jobs. |
| fam_step_up_email_challenges | reauthorize | Invalidate old challenges and authorization windows; never copy codes/digests/counters as proof of identity. |
| fam_submission_quotas | reconcile | Reconcile current window counts or keep submission blocked until old window expires; no rate-limit bypass; original expiry. |
| fam_user_profiles | reconcile | Preserve UUID and verified school/role/active state only through independent old and new ownership proofs; minimize fields, review consent/basis, never import credentials. |

Current evidence: CI at 770ce977 reports all four workflows successful. Earlier disposable YDB runs confirmed 13-table core restoration and an additional operational fixture; this does not establish complete field-level mapping or restoration of every table. Existing migration architecture is retained.
