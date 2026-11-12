import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRetryableModerationFailure,
  retryDelaySeconds,
} from "../../supabase/functions/fam-listing-image-worker/retry-policy.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const submit = readFileSync(resolve(root, "supabase/functions/submit-content/index.ts"), "utf8");
const worker = readFileSync(resolve(root, "supabase/functions/fam-listing-image-worker/index.ts"), "utf8");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20261112140000_fam_media_resilience_and_student_identity.sql"),
  "utf8",
);
const reviewer = readFileSync(resolve(root, "supabase/functions/moderate/dispute-reviewer.ts"), "utf8");
const moderate = readFileSync(resolve(root, "supabase/functions/moderate/index.ts"), "utf8");
const contentSafety = readFileSync(resolve(root, "supabase/functions/moderate/content-safety.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");

test("avatar uploads are enqueued privately instead of being deleted on quota/provider errors", () => {
  const start = submit.indexOf('if (kind === "avatar") {');
  const end = submit.indexOf('const quotaResult = await adminRequest("rpc/consume_content_quota"', start);
  assert.ok(start >= 0 && end > start);
  const branch = submit.slice(start, end);
  assert.match(branch, /rpc\/enqueue_avatar_image_moderation_task/);
  assert.match(branch, /status: "pending"/);
  assert.match(branch, /предыдущий аватар продолжит отображаться/i);
  assert.doesNotMatch(branch, /removePendingAvatarImage/);
  assert.match(html, /\["approved", "pending"\]\.includes\(submission\.status\)/);
  assert.match(html, /server now owns the private staged file and queue task/);
});

test("avatar moderation uses a durable private queue and swaps only the current request", () => {
  assert.match(migration, /create table if not exists private\.avatar_image_moderation_queue/i);
  assert.match(migration, /pending_avatar_request_id/);
  assert.match(migration, /claim_avatar_image_moderation_tasks/);
  assert.match(migration, /finish_avatar_image_moderation_task/);
  assert.match(migration, /v_pointer is distinct from p_queue_id/);
  assert.match(migration, /status='superseded'/);
  assert.match(migration, /revoke all on function public\.enqueue_avatar_image_moderation_task\(uuid,text\) from public,anon,authenticated/i);
  assert.match(migration, /grant execute on function public\.enqueue_avatar_image_moderation_task\(uuid,text\) to service_role/i);
  assert.match(worker, /processAvatarTask/);
  assert.match(worker, /claim_avatar_image_moderation_tasks/);
  assert.match(worker, /publishApprovedAvatarImage/);
});

test("quota failures keep the listing image private and retry after text-only publication", () => {
  assert.equal(isRetryableModerationFailure({ action: "pending", reason_code: "image_review_quota_exceeded" }), true);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(retryDelaySeconds), [60, 180, 600, 1800, 3600, 21600, 21600]);
  assert.match(worker, /publish_text_only:\s*true/);
  assert.match(worker, /Фото сохранено приватно и будет добавлено после успешной проверки/);
  assert.match(migration, /p_publish_text_only boolean default false/i);
  assert.match(migration, /l\.status='active' and l\.moderation_status='approved'/);
  assert.match(migration, /and l\.image_url is null/);
  assert.match(migration, /set status='active',moderation_status='approved',image_url=null/);
  assert.match(migration, /status='active' and moderation_status='approved' and image_url is null/);
});

test("normal photo moderation rejection never publishes the unreviewed staged image", () => {
  assert.match(worker, /if \(moderation\.action === "reject"\)/);
  assert.match(worker, /removeObject\("listing-images-pending", task\.image_path\)/);
  assert.match(worker, /finish\(task, "rejected"/);
  assert.match(worker, /publishApprovedImage\(task, signedUrl\)/);
  assert.match(migration, /p_image_url is null or length\(p_image_url\)>2000/);
});

test("constructive criticism is allowed and ordinary insults do not enter manual review", () => {
  assert.match(reviewer, /КОНСТРУКТИВНАЯ КРИТИКА разрешена/);
  assert.match(reviewer, /Обычная грубость, резкая формулировка, непопулярное мнение или критика не являются основанием для manual_review/);
  assert.match(reviewer, /ОТКЛОНЯЙ автоматически/);
  assert.match(reviewer, /НАПРАВЛЯЙ НА manual_review только реальные признаки ненависти или дискриминации/);
  assert.match(reviewer, /const highRiskCodes = new Set/);
  assert.match(reviewer, /decision === "manual_review" && highRiskCodes\.has/);
  assert.match(reviewer, /action: "reject",\s*reason_code: "unclear_or_personal_accusation"/);
});

test("a provider outage does not block a locally clean idea, while local risk stays held", () => {
  assert.match(reviewer, /if \(!apiKey\) return safeLocalFallback\(\)/);
  assert.match(reviewer, /action: "ok",\s*reason_code: "safe_local_fallback"/);
  assert.match(reviewer, /action: "pending",\s*reason_code: "local_policy_flag_requires_review"/);
  const ideaStart = moderate.indexOf("if (isIdea) {");
  const ideaEnd = moderate.indexOf("// For locally flagged text", ideaStart);
  assert.ok(ideaStart >= 0 && ideaEnd > ideaStart);
  const ideaPath = moderate.slice(ideaStart, ideaEnd);
  assert.match(ideaPath, /reviewIdeaContent\(value, OPENAI_KEY, policyFlag\?\.code \?\? null\)/);
  assert.doesNotMatch(ideaPath, /if \(!OPENAI_KEY\)/);
  assert.match(contentSafety, /serious_hate_or_threat/);
});

test("student identity fields are gathered at registration and editable in the user's own profile", () => {
  assert.match(html, /id="authFirstName"/);
  assert.match(html, /id="authLastName"/);
  assert.match(html, /id="authClassName"/);
  assert.match(html, /first_name: firstName/);
  assert.match(html, /last_name: lastName/);
  assert.match(html, /class_name: className/);
  assert.match(html, /id="profileStudentIdentityForm"/);
  assert.match(html, /\.update\(\{ first_name, last_name, class_name \}\)/);
});

test("student identity is visible to school admins only through same-school admin queries", () => {
  assert.match(migration, /grant select \(first_name,last_name,class_name\) on public\.profiles to authenticated/i);
  assert.match(migration, /grant update \(first_name,last_name,class_name\) on public\.profiles to authenticated/i);
  assert.match(contentSafety, /serious_hate_or_threat/);
  const council = readFileSync(resolve(root, "supabase/functions/council-management/index.ts"), "utf8");
  assert.match(council, /profiles\?select=id,email,role,created_at,first_name,last_name,class_name&school_id=eq\./);
  assert.match(council, /profiles\?select=id,email,role,first_name,last_name,class_name&school_id=eq\./);
  assert.match(html, /Класс: \$\{esc\(studentClass\)\}/);
  assert.match(html, /studentName \|\| row\.email/);
});
