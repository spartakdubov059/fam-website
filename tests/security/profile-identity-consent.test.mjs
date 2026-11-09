import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const council = readFileSync(new URL("../supabase/functions/council-management/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261109193500_fam_profile_identity_and_signup_consents.sql", import.meta.url), "utf8");
const terms = readFileSync(new URL("../terms.html", import.meta.url), "utf8");
const privacy = readFileSync(new URL("../privacy.html", import.meta.url), "utf8");
const consent = readFileSync(new URL("../personal-data-consent.html", import.meta.url), "utf8");

test("the Council workspace is a clear top-level profile section", () => {
  assert.match(html, /id="adminIdeasDash" class="profile-box profile-disclosure/);
  assert.doesNotMatch(html, /class="profile-shortcuts"/);
  assert.match(html, /Участники школы/);
});

test("school admin account and listing cards show the selected identity before removal", () => {
  assert.match(html, /data-person-name=/);
  assert.match(html, /data-person-contact=/);
  assert.match(html, /Введите УДАЛИТЬ для подтверждения/);
  assert.match(html, /author_display_name/);
  assert.match(council, /display_name/);
  assert.match(council, /phone_masked/);
});

test("users may update only their own display name through the authenticated management function", () => {
  assert.match(council, /action === "update_own_display_name"/);
  assert.match(council, /profiles\?id=eq\." \+ encodeURIComponent\(actorId\)/);
});

test("registration offers email and phone and requires two separate explicit checkboxes", () => {
  assert.match(html, /data-auth-method="email"/);
  assert.match(html, /data-auth-method="phone"/);
  assert.match(html, /id="authTermsAccepted"/);
  assert.match(html, /id="authPersonalDataAccepted"/);
  assert.match(html, /shouldCreateUser: isReg/);
  assert.match(html, /verifyOtp\(\{ phone, token, type: "sms" \}\)/);
  assert.match(migration, /terms_accepted_at timestamptz/);
  assert.match(migration, /personal_data_consent_at timestamptz/);
  assert.match(terms, /Пользовательское соглашение FAM/);
  assert.match(privacy, /Политика конфиденциальности FAM/);
  assert.match(consent, /Согласие на обработку персональных данных/);
});

test("phone signup and sensitive actions support SMS reauthentication", () => {
  assert.match(html, /настройте SMS-провайдера/);
  assert.match(html, /signInWithOtp\(\{ phone: user\.phone/);
  assert.match(html, /verifyOtp\(\{ phone: user\.phone, token: code\.trim\(\), type: "sms" \}\)/);
});

test("admin school listing moderation is reversible, audited and identity-aware", () => {
  assert.match(html, /data-action="toggle-school-listing"/);
  assert.match(html, /Скрыть с доски/);
  assert.match(html, /Вернуть на доску/);
  assert.match(council, /action === "set_listing_visibility"/);
  assert.match(council, /requestedStatus === "hidden"/);
  assert.match(council, /listing_hidden_by_admin/);
  assert.match(council, /listing_restored_by_admin/);
});

test("permanent admin account deletion requires a reason and a clear target", () => {
  assert.match(html, /Почему требуется удалить аккаунт/);
  assert.match(council, /reason\.length < 15 \|\| reason\.length > 400/);
  assert.match(council, /reason,/);
});
