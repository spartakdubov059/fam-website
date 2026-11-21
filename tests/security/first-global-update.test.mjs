import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const html=readFileSync(resolve(root,"index.html"),"utf8");
const submit=readFileSync(resolve(root,"supabase/functions/submit-content/index.ts"),"utf8");
const moderator=readFileSync(resolve(root,"supabase/functions/moderate/index.ts"),"utf8");
const worker=readFileSync(resolve(root,"supabase/functions/fam-listing-image-worker/index.ts"),"utf8");
const queueMigration=readFileSync(resolve(root,"supabase/migrations/20261117120000_remove_orphan_idea_image_worker_cron.sql"),"utf8");
const migration=readFileSync(resolve(root,"supabase/migrations/20261113090000_idea_image_attachments.sql"),"utf8");
const pulse=readFileSync(resolve(root,"school-pulse.js"),"utf8");

test("idea photos are limited, staged privately, checked before server-side publishing, and school-scoped",()=>{
 assert.match(html,/До 3 фото, JPG\/PNG\/WebP, до 2 МБ каждое/);
 assert.match(html,/files.length > 3/);
 assert.match(html,/file.size > 2 \* 1024 \* 1024/);
 assert.match(html,/listing-images-pending/);
 assert.match(submit,/submittedImages.length > 3/);
 assert.match(submit,/moderate\(text, authorization, origin, true, imageUrl, safetyContext\)/);
 assert.match(moderator,/if \(ideaReview\.action !== "ok" \|\| !imageUrl\)/);
 assert.match(moderator,/clean idea with a photo continues through the shared visual image checks/);
 assert.match(submit,/if \(imageReview\.action === "pending"\) pendingImageReview = true/);
 assert.match(submit,/stagePendingIdeaImage\(imageUrl, userId\)/);
 assert.match(submit,/image_paths: stagedImagePaths/);
 assert.match(submit,/enqueueIdeaImageModerationTask\(idea\.id, userId, profile\.school_id, imagePath\)/);
 assert.match(worker,/claim_idea_image_moderation_tasks/);
 assert.match(worker,/processIdeaTask\(task\)/);
 assert.match(moderator,/pendingImageBucket = imagePurpose === "avatar" \? "avatars-pending" : imagePurpose === "idea" \? "idea-images"/);
 assert.match(queueMigration,/cron\.unschedule/);
 assert.match(queueMigration,/fam-idea-image-moderation-every-minute/);
 assert.match(migration,/values \('idea-images',[\s\S]*?false, 2097152/i);
 assert.match(migration,/FAM idea authors and same-school staff read idea images/);
 assert.doesNotMatch(migration,/create policy[^;]+for insert to authenticated/is);
});

test("profile shows the student's name with a neutral fallback and keeps email in account settings",()=>{
 assert.match(html,/const displayName = \[profile\?\.first_name, profile\?\.last_name\]/);
 assert.match(html,/displayName \|\| "Участник FAM"/);
 assert.match(html,/id="accountEmail"/);
 assert.match(html,/\$\("accountEmail"\)\.value = user\.email/);
 assert.doesNotMatch(html,/\$\("profEmail"\)\.textContent = user\.email/);
});

test("chat subjects identify listings and events while dialogs retain listing identity",()=>{
 assert.match(html,/select\("id,title,is_event"\)/);
 assert.match(html,/relatedListing\.is_event \? "Переписка по мероприятию «" : "Переписка по объявлению «"/);
 assert.match(html,/listingIsEvent\.get\(listingId\) \? "Переписка по мероприятию «"/);
 assert.match(html,/window\.startChat\(ev\.user_id, "Переписка по мероприятию «"/);
 assert.ok(html.includes('data-listing-id="${esc(d.listingId || "")}"'));
});

test("announcements, open events, and polls lead the main hero carousel",()=>{
 assert.match(html,/id="bannerCarousel"/);
 assert.doesNotMatch(html,/id="pulseAnnouncementCarousel"/);
 assert.match(html,/data-pulse-scroll="-1"/);
 assert.match(html,/data-pulse-scroll="1"/);
 assert.match(html,/scroll-snap-type:\s*x mandatory/);
 assert.match(pulse,/hero-pulse-slide pulse-generated/);
 assert.match(pulse,/priorityNews\.map\(announcementCard\)\.concat\(polls\.map\(pollCard\),otherNews\.map\(announcementCard\)\)/);
 assert.match(pulse,/featured\.length===0/);
 assert.match(pulse,/grid\.innerHTML=""/);
});
