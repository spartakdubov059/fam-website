# RU owner access to own listings — 22 November 2026

Compared current source policy `20261121190000_restrict_listings_to_authenticated_same_school.sql` with the YDB/API implementation.

The source policy grants every authenticated author access to their own listings regardless of current application role; same-school members can read only active listings. RU public board behavior already follows the latter rule: guests receive an empty feed and active listing queries are scoped to the verified actor's school.

The RU `GET /api/v1/me/listings` endpoint had an extra `role === 'student'` restriction, hiding a person's own history after promotion to council member or school administrator. This gate was removed. The database actor is still resolved from the verified identity, and both repository queries filter exclusively by that actor's user ID. A synthetic regression test covers student, council member, school administrator, pending own listing history, and an unprofiled identity that must not reach the repository.

This preserves owner access without granting access to anyone else's listing. Unit test doubles do not prove disposable YDB integration or cloud IAM. The separate RU media route intentionally lets same-school moderators view an approved photo while its listing is pending; the source private storage policy only grants non-owner access to active listing photos. This difference remains documented for security review.

No production account, student record, cloud resource, or paid service was used.
