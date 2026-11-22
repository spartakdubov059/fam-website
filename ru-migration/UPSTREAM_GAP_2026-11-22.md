# RU owner access to own listings — 22 November 2026

Compared current source policy `20261121190000_restrict_listings_to_authenticated_same_school.sql` with the YDB/API implementation.

The source policy grants every authenticated author access to their own listings regardless of current application role; same-school members can read only active listings. RU public board behavior already follows the latter rule: guests receive an empty feed and active listing queries are scoped to the verified actor's school.

The RU `GET /api/v1/me/listings` endpoint had an extra `role === 'student'` restriction, hiding a person's own history after promotion to council member or school administrator. This gate was removed. The database actor is still resolved from the verified identity, and both repository queries filter exclusively by that actor's user ID. A synthetic regression test covers student, council member, school administrator, pending own listing history, and an unprofiled identity that must not reach the repository.

Verification: exact code head `20c492c9af4b5ae429d06b588d746574fb7475a4` passed local Node.js 22.15.0 backend tests (`459/459`), `compat/verify.mjs` (`SDK_COMPAT_PASS`) and the portable check of 8 timer files. GitHub Actions then passed on that same code head: [SDK/Sharp and backend run #45050391170](https://github.com/spartakdubov059/fam-website/actions/runs/45050391170) and [disposable YDB integration run #45050391175](https://github.com/spartakdubov059/fam-website/actions/runs/45050391175). The YDB job exercised the whole isolated schema, repository/API with synthetic data, scheduled school report, initial-admin bootstrap and local HTTP S3 adapter, then removed the disposable database. A subsequent commit only updates workflow/documentation metadata.

This preserves owner access without granting access to anyone else's listing. Mock repository tests and disposable local YDB do not prove cloud IAM or live OAuth.

## Media access correction — 23 November 2026

The previous paragraph misstated the current RU photo behavior. On code commit [`e526195`](https://github.com/spartakdubov059/fam-website/commit/e52619575b0fae817da8f569f4ef5ea1b2343350), a listing's `photo_status=approved` photo remains private to its author while the listing itself is unpublished; same-school members can read it only after listing status becomes `active`. `media-api.test.mjs` covers the owner, non-owner student, council member, school administrator and active same-school member. The current source policy in `supabase/migrations/20261122012818_restrict_listing_image_reads_to_school_members.sql` has the same approved-image rule.

The remaining distinction is for `photo_status=pending`: RU moderators of that school can fetch the private preview to make the manual decision, while the source approved-image storage policy intentionally does not grant that access. Compare this route with the full upstream image-worker and moderation flow before claiming parity. Latest code commit [`b969ce5`](https://github.com/spartakdubov059/fam-website/commit/b969ce519451393be3f33513eeefc1a28f80270a) passed Node 22 **471/471** backend tests and synthetic YDB integration ([#45071311415](https://github.com/spartakdubov059/fam-website/actions/runs/45071311415), [#45071311426](https://github.com/spartakdubov059/fam-website/actions/runs/45071311426)). Neither run exercises live Object Storage policy or Yandex Cloud IAM.

No production account, student record, cloud resource, or paid service was used.
