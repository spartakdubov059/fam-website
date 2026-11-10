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

test("registration records a chosen display name and server-enforced separate acceptance versions", () => {
  assert.match(migration, /add column if not exists display_name text/i);
  assert.match(migration, /profiles_display_name_safe/i);
  assert.match(migration, /create table if not exists private\.fam_user_legal_acceptances/i);
  assert.match(migration, /agreement_version text not null/i);
  assert.match(migration, /privacy_notice_version text not null/i);
  assert.match(migration, /personal_data_consent_version text not null/i);
  assert.match(migration, /fam_terms_accepted' is distinct from 'true'/i);
  assert.match(migration, /fam_pd_consent_accepted' is distinct from 'true'/i);
  assert.match(migration, /raise exception 'Для регистрации нужно отдельно принять/i);
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

test("email auth works while phone auth is visibly and technically disabled until localization is ready", () => {
  assert.match(frontend, /id="authIdentifier" type="email"|type="email" id="authIdentifier"/);
  assert.match(frontend, /Вход по телефону пока отключён/);
  assert.match(frontend, /if \(!rawIdentifier\.includes\("@"\)\)[\s\S]*?Сейчас вход и регистрация доступны по почте/);
  assert.match(frontend, /sb\.auth\.signUp\(\{ email: rawIdentifier, password: pass, options: \{ data \} \}\)/);
  assert.match(frontend, /sb\.auth\.signInWithPassword\(\{ email: rawIdentifier, password: pass \}\)/);
  assert.doesNotMatch(frontend, /sb\.auth\.verifyOtp/);
  assert.doesNotMatch(frontend, /sb\.auth\.signUp\(\{ phone/);
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

test("account deletion presents identity and reason without asking an already signed-in admin for the password again", () => {
  assert.match(frontend, /id="adminConfirmModal"/);
  assert.match(frontend, /Проверить удаление аккаунта/);
  assert.match(frontend, /id="adminConfirmReason"/);
  assert.match(frontend, /data-listing-titles=/);
  assert.match(frontend, /Регистрация:<\/b>/);
  assert.match(frontend, /Объявлений:<\/b>/);
  assert.match(frontend, /callCouncilManagement\("delete_account", targetId, \{ reason: cleanReason \}\)/);
  assert.match(controller, /Для удаления нужна причина длиной 15–400 символов/);
});

test("school admin actions rely on the authenticated school_admin session, not a second password prompt", () => {
  assert.doesNotMatch(frontend, /ensureRecentAdminAuthentication/);
  assert.doesNotMatch(controller, /sensitiveActions/);
  assert.match(controller, /actor\.role !== "school_admin"/);
  assert.match(controller, /if \(action === "delete_my_account"\)[\s\S]*?tokenWasIssuedRecently\(authorization\)/);
  assert.match(frontend, /if \(!user \|\| profile\?\.role !== "school_admin"\)/);
});

test("incoming school council applications are visible, counted, and correctly described as requests", () => {
  assert.match(frontend, /Заявки на вступление в Ученический совет/);
  assert.match(frontend, /schoolAdminReviewCount/);
  assert.match(frontend, /schoolAdminAccessRequests = requests/);
  assert.match(frontend, /Просит вступить в Ученический совет/);
  assert.match(frontend, /Заявка на вступление в Ученический совет/);
  assert.match(frontend, /Сейчас ваш статус — «Ученик»/);
  assert.match(frontend, /Взять заявку в работу/);
  assert.match(frontend, /Подтвердить заявку/);
});

test("opening the notification bell marks the notifications currently shown as read; later IDs stay new", () => {
  assert.match(frontend, /fam_notif_read_v2_/);
  assert.match(frontend, /function markNotificationsRead\(notes\)/);
  assert.match(frontend, /markNotificationsRead\(notes\)/);
  assert.match(frontend, /schoolAdminAccessRequests\.forEach/);
  assert.match(frontend, /setInterval\(\(\) => \{[\s\S]*?loadSchoolAdminAccess\(\)/);
  assert.match(frontend, /open-admin-applications/);
});

test("text-only hero banners use readable responsive typography and do not claim 24/7 moderation", () => {
  assert.match(frontend, /hero-slide hero-text/);
  assert.match(frontend, /\.hero-slide\.hero-text \.db-title/);
  assert.match(frontend, /Проверка ИИ/);
  assert.match(frontend, /ИИ-модерация · проверяет публикации/);
  assert.doesNotMatch(frontend, /защита 24\/7/);
  assert.doesNotMatch(frontend, /ИИ-модерация · статус не проверен/);
});

test("idea submission explains automatic AI checks and sends only uncertain cases to the Council for review", () => {
  assert.match(frontend, /ИИ проверяет идеи на спам, рекламу, личные контакты и небезопасные призывы/);
  assert.match(frontend, /ИИ не смог уверенно оценить идею/);
  assert.match(frontend, /ИИ проверяет спам, контакты и безопасность/);
});

test("admin listing moderation is reversible, school-scoped, and audited", () => {
  assert.match(migration, /add column if not exists admin_hidden boolean/i);
  assert.match(migration, /add column if not exists admin_hidden_reason text/i);
  assert.match(controller, /if \(action === "moderate_listing"\)/);
  assert.match(controller, /ownerSchoolId !== actor\.school_id/);
  assert.match(controller, /decision === "hide" && listing\.status !== "active"/);
  assert.match(controller, /Уже скрытые публикации не изменяются/);
  assert.match(controller, /status: "hidden"/);
  assert.match(controller, /status: "active"/);
  assert.match(controller, /"listing_hidden"/);
  assert.match(controller, /"listing_restored"/);
  assert.match(controller, /action === "delete_listing"[\s\S]*?410/);
  assert.match(frontend, /Скрыть с доски/);
  assert.match(frontend, /Вернуть на доску/);
  assert.doesNotMatch(frontend, /data-action="delete-school-listing"/);
});

test("account deletion opens a visual confirmation with identity and recent owned listings", () => {
  assert.match(frontend, /id="adminConfirmModal"/);
  assert.match(frontend, /id="adminConfirmDetails"/);
  assert.match(frontend, /data-listing-titles=/);
  assert.match(frontend, /Последние публикации:/);
  assert.match(frontend, /pendingAdminReason = options\.reason/);
  assert.match(controller, /listing_titles: owned\.slice\(0, 5\)/);
  assert.match(controller, /target_created_at: target\?\.created_at/);
});

test("moderation dialog shows the author and listing details before reversible hide or restore", () => {
  assert.match(frontend, /data-category=/);
  assert.match(frontend, /data-description=/);
  assert.match(frontend, /data-price=/);
  assert.match(frontend, /Автор:<\/b>/);
  assert.match(frontend, /Скрыть с доски/);
  assert.match(frontend, /Вернуть на доску/);
  assert.match(frontend, /Объявление будет скрыто с доски, но не удалено/);
  assert.match(controller, /listing_titles: owned\.slice\(0, 5\)/);
});

test("legal documents are separate drafts and disclose the required operator details", () => {
  assert.match(agreement, /Пользовательское соглашение FAM/);
  assert.match(agreement, /Оператор сервиса:/);
  assert.match(agreement, /проект документа/i);
  assert.match(consent, /Согласие на обработку персональных данных/);
  assert.match(consent, /Supabase/i);
  assert.match(consent, /Франкфурт/i);
  assert.match(consent, /оператор обязан определить возрастные ограничения/i);
});

test("the school dashboard is moved to the first level of the profile and navigation is reduced", () => {
  assert.match(frontend, /id="profileWorkPanel"/);
  assert.match(frontend, /workSlot\.appendChild\(councilDashboard\)/);
  assert.match(frontend, /Панель школы/);
  assert.doesNotMatch(frontend, /<div class="profile-shortcuts"/);
});

test("the registration trigger rejects missing explicit consent even if the UI is bypassed", () => {
  const triggerStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.handle_new_user()");
  const triggerEnd = migration.indexOf("REVOKE ALL ON FUNCTION public.handle_new_user()", triggerStart);
  const trigger = migration.slice(triggerStart, triggerEnd);
  assert.match(trigger, /fam_terms_accepted' IS DISTINCT FROM 'true'/i);
  assert.match(trigger, /fam_pd_consent_accepted' IS DISTINCT FROM 'true'/i);
  assert.match(trigger, /v_terms_version IS NULL/i);
  assert.match(trigger, /v_privacy_version IS NULL/i);
  assert.match(trigger, /v_consent_version IS NULL/i);
});
test("profile and admin preview tolerate the old database before the identity migration", () => {
  assert.match(frontend, /select\("id,avatar_url,created_at,city,school_id,role"\)/);
  assert.match(frontend, /user\.user_metadata\?\.display_name/);
  assert.match(controller, /profiles\?select=id,school_id,role,email,phone_hint,display_name,created_at/);
  assert.match(controller, /profiles\?select=id,school_id,role,email,created_at/);
  assert.match(controller, /listings\?select=id,title,description,price_text,category,user_id,status,is_event,created_at/);
  assert.match(controller, /Для скрытия и восстановления нужно сначала обновить базу FAM/);
});


test("FAM dashboard keeps only safety signals; general analytics belong in the external daily report", () => {
  assert.doesNotMatch(frontend, /famAgentAdminPanel|famAgentReportSummary|famAgentIdeasList|loadFamAgentDashboard|refresh-agent-dashboard|review-fam-agent-idea/);
  assert.match(frontend, /loadUserSafetyReports/);
  assert.match(frontend, /userSafetyReportsList/);
});
