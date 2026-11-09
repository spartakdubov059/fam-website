import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const backend = readFileSync(new URL("../../supabase/functions/council-management/index.ts", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../../supabase/migrations/20261110003000_profile_consent_and_listing_moderation.sql", import.meta.url),
  "utf8",
);
const agreement = readFileSync(new URL("../../agreement.html", import.meta.url), "utf8");
const privacy = readFileSync(new URL("../../privacy.html", import.meta.url), "utf8");

test("registration asks for a nickname and explicit, separate unchecked consent", () => {
  assert.match(frontend, /id="authDisplayName"/);
  assert.match(frontend, /id="termsConsent"/);
  assert.match(frontend, /id="privacyConsent"/);
  assert.match(frontend, /if\s*\(!\$\("termsConsent"\)\.checked\s*\|\|\s*!\$\("privacyConsent"\)\.checked\)/);
  assert.match(frontend, /terms_version:"2026-11-10-v1"/);
  assert.match(frontend, /privacy_version:"2026-11-10-v1"/);
  assert.doesNotMatch(frontend, /id="termsConsent"[^>]*checked/);
  assert.doesNotMatch(frontend, /id="privacyConsent"[^>]*checked/);
});

test("new account profiles record consent versions and timestamps only on actual signup", () => {
  assert.match(migration, /add column if not exists terms_accepted_at timestamptz/i);
  assert.match(migration, /add column if not exists privacy_accepted_at timestamptz/i);
  assert.match(migration, /v_terms_version is distinct from '2026-11-10-v1'/i);
  assert.match(migration, /v_privacy_version is distinct from '2026-11-10-v1'/i);
  assert.match(migration, /terms_version, terms_accepted_at,[\s\S]*?privacy_version, privacy_accepted_at/i);
  assert.match(migration, /pg_catalog\.now\(\)/);
});

test("phone registration is not shown as available without a configured SMS provider", () => {
  assert.match(frontend, /Регистрация по телефону пока не включена/);
  assert.doesNotMatch(frontend, /signInWithOtp\(\s*\{\s*phone:/);
});

test("school admin overview returns identity and listing context for the same school only", () => {
  assert.match(backend, /profiles\?select=id,email,role,created_at,display_name&school_id=eq\./);
  assert.match(backend, /display_name: typeof row\.display_name/);
  assert.match(backend, /listing_count: ownListings\.length/);
  assert.match(backend, /owner_display_name: owner\?\.display_name/);
  assert.match(backend, /target_display_name: target\?\.display_name/);
});

test("account removal requires an audit reason and is confirmed with account context", () => {
  assert.match(frontend, /Проверить удаление аккаунта/);
  assert.match(frontend, /callCouncilManagement\("delete_account",targetId,\{reason\}\)/);
  assert.match(backend, /if \(action === "delete_account"\)[\s\S]*?reason\.length < 15/);
  assert.match(backend, /account_deleted_by_admin[\s\S]*?reason,/);
});

test("listing moderation is reversible, school-scoped, and reasoned", () => {
  assert.match(frontend, /data-action="block-school-listing"/);
  assert.match(frontend, /data-action="restore-school-listing"/);
  assert.match(frontend, /Автор:[\s\S]*?Описание:/);
  assert.match(backend, /action === "block_listing" \|\| action === "restore_listing"/);
  assert.match(backend, /ownerSchoolId !== actor\.school_id/);
  assert.match(backend, /status: "blocked", moderation_reason: reason/);
  assert.match(backend, /status: "active", moderation_reason: null/);
  assert.match(migration, /add column if not exists moderation_reason text/i);
});

test("admin workspace is separated from idea submission and has compact grouped sections", () => {
  assert.match(frontend, /id="adminIdeasDash"[^>]*>[\s\S]*?<b>Панель Совета/);
  assert.match(frontend, /<summary>Участники и запросы/);
  assert.match(frontend, /<summary>Объявления школы/);
  assert.match(frontend, /<summary>История действий/);
  assert.match(frontend, /return "Ученик";/);
});

test("legal pages identify themselves as drafts and disclose current hosting region", () => {
  assert.match(agreement, /ЭТО ЧЕРНОВИК/);
  assert.match(privacy, /ЭТО ЧЕРНОВИК/);
  assert.match(privacy, /eu-central-1/);
  assert.match(agreement, /\[УКАЗАТЬ.*ОПЕРАТОР/i);
  assert.match(privacy, /\[УКАЗАТЬ.*ОПЕРАТОР/i);
});
