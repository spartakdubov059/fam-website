# FAM OpenAI moderation data review

**Status:** proposal only. This document and its code changes are not deployed. Production moderation must not be changed until the owner approves the data-processing change.

## Current data flow verified against `moderate` v59

- The OpenAI Moderation endpoint (`omni-moderation-latest`) receives the full submitted text. For image-bearing submissions it also receives an image URL. The URL is a signed URL for a private Supabase Storage object; it contains an object path and a temporary `token` query parameter. The current URL validity is 600 seconds.
- Idea review and contextual review use `gpt-5-mini` through Chat Completions and receive the submitted text. They do not receive the image itself.
- The local contact-data gate rejects detected phone numbers, email addresses, URLs, social handles, and address-like data before external calls. It does not reliably identify names, indirect identifiers, or all sensitive facts.
- The deployed function is active at version 59. The deployed `index.ts` and supporting moderation sources were checked against `main`; the current proposal is not live.

## Proposed minimization

1. Keep the existing local contact-data rejection.
2. Before each OpenAI text request, redact clearly labelled names and identifiers and common names following school-role cues. Keep incident verbs and context so threats, harassment, and bullying remain classifiable.
3. For images, fetch the private object server-side only after validating the exact Supabase origin, expected bucket/path, and signed-token presence. Reject redirects, unsupported MIME types, fetch timeouts, and images over 5 MiB. Send accepted bytes to the Moderation endpoint as a `data:` URL instead of sending a Supabase signed URL.
4. If an image cannot be safely fetched and bounded, keep the content hidden and return `pending` for human review. Do not silently approve it.

This removes the Storage bearer-like token from the outbound OpenAI request. It does **not** stop OpenAI from receiving image pixels, which may show a student's face, name, school, or other identifying details. If that is outside the approved data boundary, image-bearing submissions must stay in manual review or use a separately approved local image-redaction process.

## Safety and quality effects

- Redaction preserves explicit bullying/threat language in synthetic checks, but is best-effort: unlabeled names, nicknames, unusual spelling, and contextual clues can remain. Automated text redaction cannot guarantee anonymization.
- Redacting an aggressor/target name should usually retain whether a person was threatened or bullied. It may remove useful context about who is being targeted, so benchmark false negatives and false positives on an approved, de-identified safety set before rollout.
- Unsupported, oversized, or unavailable images become `pending` rather than being approved. This is fail-closed and may increase manual-review load or delay publication.
- No moderation category, policy, or approval rule is weakened by this proposal.

## Model and cost notes (checked 2026-11-23)

- `omni-moderation-latest` is OpenAI's text-and-image moderation model. The moderation endpoint is documented as free; published default rate limits include 250 RPM, 5,000 RPD, and 10,000 TPM, with account-specific tiers. Actual FAM account limits and remaining quota are not visible from this repository.
- `gpt-5-mini` is currently listed at $0.25 per 1M input tokens and $2 per 1M output tokens, and the model page says Free is unsupported. The model is deprecated, with shutdown scheduled for 2026-12-11. No model switch is included in this proposal.
- `gpt-5.4-mini` is a currently documented Chat Completions option at $0.75 per 1M input tokens and $4.50 per 1M output tokens; Free is unsupported. Switching would raise listed token prices and needs separate owner approval and a quality/cost evaluation.
- OpenAI API data controls say abuse-monitoring content may be retained up to 30 days by default unless the account has approved different controls. FAM's account-level data controls were not available for inspection, so their setting is unknown.

Sources: [Moderation model and limits](https://developers.openai.com/api/docs/models/omni-moderation-latest), [Moderations API reference](https://developers.openai.com/api/reference/resources/moderations/methods/create), [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data), [GPT-5 mini](https://developers.openai.com/api/docs/models/gpt-5-mini), [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

## Approval boundary

This draft may be reviewed and tested in CI. Do not merge or deploy it until the owner approves the proposed processing of redacted text and image bytes by OpenAI, including the remaining image-identification risk and manual-review fallback.
