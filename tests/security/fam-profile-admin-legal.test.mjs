import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const manager = readFileSync(new URL("../../supabase/functions/council-management/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../supabase/migrations/20261110074500_add_fam_display_names_and_explicit_consents.sql", import.meta.url), "utf8");
const terms = readFileSync(new URL("../../terms.html", import.meta.url), "utf8");
const privacy = readFileSync(new URL("../../privacy.html", import.meta.url), "utf8");

test("Council workspace is no longer buried inside the three-button profile shortcut grid", () => {
  assert.match(html, /id="profileWorkPanel"/);
  assert.match(html, /workSlot\.appendChild\(councilDashboard\)/);
  assert.match(html, /Рабочая панель школы/);
  assert.doesNotMatch(html, /<div class="profile-shortcuts"/);
});

test("school account labels are clear and identity cards show context without exposing full contacts", () => {
  assert.match(html, /if \(role === "student"\) return "Ученик"/);
  assert.doesNotMatch(html, /Обычный пользователь/);
  assert.match(html, /Контакт:|Почта:/);
  assert.match(html, /ID: #|ID #/);
  assert.match(html, /Аккаунт создан|В FAM с/);
  assert.match(html, /Последние публикации|Публикаций пока нет/);
  assert.match(manager, /email: maskEmail\(row\.email\)/);
  assert.match(manager, /display_name/);
});

test("permanent account deletion identifies the target and requires the short ID confirmation", () => {
  assert.match(html, /Имя: " \+ \(details\.name/);
  assert.match(html, /последние 6 символов ID/);
  assert.match(html, /ID не совпал/);
});

test("school listing moderation shows its author and supports reversible hide and restore", () => {
  assert.match(manager, /action === "set_listing_status"/);
  assert.match(manager, /\["active", "hidden"\]/);
  assert.match(manager, /owner_display_name/);
  assert.match(manager, /owner_email: maskEmail/);
  assert.match(manager, /listing_hidden/);
  assert.match(manager, /listing_restored/);
  assert.match(html, /Скрыть публикацию/);
  assert.match(html, /Вернуть публикацию/);
  assert.match(html, /Удалить навсегда/);
  assert.match(html, /"set_listing_status"/);
});

test("registration requires two separate, initially unchecked consent confirmations", () => {
  assert.match(html, /id="termsAccepted"/);
  assert.match(html, /id="privacyAccepted"/);
  assert.match(html, /termsAccepted"\)\.checked/);
  assert.match(html, /privacyAccepted"\)\.checked/);
  const consentMarkup = html.match(/<div class="signup-consent hidden" id="signupConsentGroup">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.ok(consentMarkup.length > 0);
  assert.doesNotMatch(consentMarkup, /<input[^>]*checked/i);
  assert.match(html, /fam_terms_version: "1\.0"/);
  assert.match(html, /fam_privacy_version: "1\.0"/);
  assert.match(migration, /private\.user_consents/);
  assert.match(migration, /terms_accepted_at/);
  assert.match(migration, /privacy_accepted_at/);
});

test("phone sign-up is visibly unavailable until lawful hosting and SMS provider are ready", () => {
  assert.match(html, /phoneSignupNotice/);
  assert.match(html, /SMS[‑-]?провайдер/);
  assert.match(privacy, /Регистрация по номеру телефона в текущей версии не включена/);
});

test("legal documents are present and clearly marked as drafts pending operator details and review", () => {
  assert.match(terms, /ЧЕРНОВИК/);
  assert.match(terms, /полное имя или наименование оператора/);
  assert.match(privacy, /ЧЕРНОВИК, НЕ ДЛЯ ВВОДА В ДЕЙСТВИЕ/);
  assert.match(privacy, /eu-central-1/);
  assert.match(terms, /безопасн/);
});

test("deploy preview remains compatible before display_name migration is applied", () => {
  assert.match(manager, /profiles\?select=id,school_id,role,email,created_at,display_name/);
  assert.match(manager, /profiles\?select=id,school_id,role,email,created_at&id=eq/);
  assert.match(manager, /profiles\?select=id,email,role,created_at&school_id=eq/);
  assert.match(html, /user\.user_metadata\?\.display_name/);
});

test("hiding or restoring a school listing requires a fresh administrator login on the server", () => {
  const sensitive = manager.match(/const sensitiveActions = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
  assert.match(sensitive, /"set_listing_status"/);
  assert.match(manager, /ownerSchoolId !== actor\.school_id/);
  assert.match(manager, /listing_hidden/);
  assert.match(manager, /listing_restored/);
});
