import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const html=readFileSync(resolve(root,"index.html"),"utf8");
const submit=readFileSync(resolve(root,"supabase/functions/submit-content/index.ts"),"utf8");
const moderator=readFileSync(resolve(root,"supabase/functions/moderate/index.ts"),"utf8");
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
 assert.match(submit,/publishPendingIdeaImage/);
 assert.match(submit,/image_paths: publishedImagePaths/);
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

test("announcements stay separate from listings and polls and disappear when empty",()=>{
 assert.match(html,/id="pulseAnnouncementCarousel"/);
 assert.match(html,/data-pulse-scroll="-1"/);
 assert.match(html,/data-pulse-scroll="1"/);
 assert.match(html,/scroll-snap-type:x mandatory/);
 assert.match(pulse,/announcementTrack\.innerHTML=news\.map\(announcementCard\)\.join/);
 assert.match(pulse,/carousel\?\.classList\.toggle\("hidden",news\.length===0\)/);
 assert.match(pulse,/grid\.innerHTML=polls\.map\(pollCard\)\.join/);
});
