import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261109203000_fam_profile_identity_legal_acceptance_and_listing_moderation.sql", import.meta.url),
  "utf8",
);
const controller = readFileSync(
  new URL("../../supabase/functions/council-management/index.ts", import.meta.url),
  "utf8",
);
const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const agreement = readFileSync(new URL("../../user-agreement.html", import.meta.url), "utf8");
const consent = readFileSync(new URL("../../personal-data-consent.html", import.meta.url), "utf8");

test("registration records a chosen display name and separate acceptance versions", () => {
  assert.match(migration, /add column if not exists display_name text/i);
  assert.match(migration, /create table if not exists private\.fam_user_legal_acceptances/i);
  assert.match(migration, /agreement_version text not null/i);
  assert.match(migration, /privacy_notice_version text not null/i);
  assert.match(migration, /personal_data_consent_version text not null/i);
  assert.match(migration, /fam_terms_accepted' = 'true'/i);
  assert.match(migration, /fam_pd_consent_accepted' = 'true'/i);
  assert.match(migration, /insert into private\.fam_user_legal_acceptances/i);
});

test("signup requires two explicit unchecked legal choices and links to both documents", () => {
  assert.match(frontend, /id="authTermsAccepted"/);
  assert.match(frontend, /id="authPrivacyAccepted"/);
  assert.match(frontend, /if \(!\$\("authTermsAccepted"\)\.checked\)/);
  assert.match(frontend, /if \(!\$\("authPrivacyAccepted"\)\.checked\)/);
  assert.doesNotMatch(frontend, /id="authTermsAccepted"[^>]*checked/i);
  assert.doesNotMatch(frontend, /id="authPrivacyAccepted"[^>]*checked/i);
  assert.match(frontend, /href="user-agreement\.html"/);
  assert.match(frontend, /href="personal-data-consent\.html"/);
});

test("email and phone registration use the selected Auth method and phone OTP", () => {
  assert.match(frontend, /sb\.auth\.signUp\(\{ phone, password, options: \{ data \} \}\)/);
  assert.match(frontend, /sb\.auth\.signUp\(\{ email: rawIdentifier, password: pass, options: \{ data \} \}\)/);
  assert.match(frontend, /sb\.auth\.verifyOtp\(\{ phone: pendingPhone, token, type: "sms" \}\)/);
  assert.match(frontend, /sb\.auth\.signInWithPassword\(\{ \.\.\.identity, password: pass \}\)/);
  assert.match(migration, /phone_hint = CASE/i);
});

test("admin overview returns readable names, masked contacts, and account context only", () => {
  assert.match(controller, /function contactHint\(email: unknown, phoneHint: unknown\)/);
  assert.match(controller, /function profileDisplayName\(row: any\)/);
  assert.match(controller, /contact_hint: contactHint\(row\.email, row\.phone_hint\)/);
  assert.match(controller, /display_name: profileDisplayName\(row\)/);
  assert.match(frontend, /row\.display_name/);
  assert.match(frontend, /row\.contact_hint/);
  assert.match(frontend, /row\.listing_count/);
  assert.match(frontend, /return "Ученик"/);
});

test("account deletion presents identity, requires a reason, and uses fresh admin authentication", () => {
  assert.match(frontend, /Укажите причину удаления \(15–400 символов\)/);
  assert.match(frontend, /Регистрация: /);
  assert.match(frontend, /Объявлений: /);
  assert.match(frontend, /callCouncilManagement\("delete_account", targetId, \{ reason: cleanReason \}\)/);
  assert.match(controller, /Для удаления нужна причина длиной 15–400 символов/);
});

test("admin listing moderation is reversible, school-scoped, and audited", () => {
  assert.match(migration, /add column if not exists admin_hidden boolean/i);
  assert.match(migration, /add column if not exists admin_hidden_reason text/i);
  assert.match(controller, /if \(action === "moderate_listing"\)/);
  assert.match(controller, /ownerSchoolId !== actor\.school_id/);
  assert.match(controller, /status: "hidden"/);
  assert.match(controller, /status: "active"/);
  assert.match(controller, /"listing_hidden"/);
  assert.match(controller, /"listing_restored"/);
  assert.match(controller, /action === "delete_listing"[\s\S]*?410/);
  assert.match(frontend, /Скрыть с доски/);
  assert.match(frontend, /Вернуть на доску/);
  assert.doesNotMatch(frontend, /data-action="delete-school-listing"/);
});

test("legal documents are separate drafts and disclose the required operator details", () => {
  assert.match(agreement, /Пользовательское соглашение FAM/);
  assert.match(agreement, /Оператор сервиса:/);
  assert.match(agreement, /проект документа/i);
  assert.match(consent, /Согласие на обработку персональных данных/);
  assert.match(consent, /Supabase/i);
  assert.match(consent, /Франкфурт/i);
  assert.match(consent, /оператор должен определить возрастные ограничения/i);
});
