import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isAllowedApplicantNote,
  mapSchoolAdminRequests,
} from "../../supabase/functions/school-admin-access/access-controls.js";

test("accepts only the current Council roles and the legacy member label", () => {
  assert.equal(isAllowedApplicantNote("Участник Ученического совета"), true);
  assert.equal(isAllowedApplicantNote("Администратор"), true);
  assert.equal(isAllowedApplicantNote("Член Ученического совета"), true);
  assert.equal(isAllowedApplicantNote("Председатель Ученического совета"), false);
  assert.equal(isAllowedApplicantNote("Заместитель председателя Ученического совета"), false);
  assert.equal(isAllowedApplicantNote("Мой телефон +7 900 123-45-67"), false);
  assert.equal(isAllowedApplicantNote("learner@example.ru"), false);
  assert.equal(isAllowedApplicantNote(undefined), false);
});

test("school admin request mapping returns only same-school identity fields and no email", () => {
  const source = readFileSync(new URL("../../supabase/functions/school-admin-access/access-controls.js", import.meta.url), "utf8");
  const mapped = mapSchoolAdminRequests([{
    request_id: "6e8ecb53-2fb6-42a5-9ff8-d4d4b4d5b7c9",
    user_id: "12345678-1234-4234-8234-123456789abc",
    applicant_first_name: "Анна",
    applicant_last_name: "Иванова",
    applicant_class: "8А",
    applicant_email: "student@example.ru",
    applicant_note: "Участник Ученического совета",
    created_at: "2026-11-08T10:00:00Z",
  }]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, "6e8ecb53-2fb6-42a5-9ff8-d4d4b4d5b7c9");
  assert.equal(mapped[0].user_id, "789ABC");
  assert.equal(mapped[0].applicant_first_name, "Анна");
  assert.equal(mapped[0].applicant_last_name, "Иванова");
  assert.equal(mapped[0].applicant_class, "8А");
  assert.equal(Object.hasOwn(mapped[0], "applicant_email"), false);
  assert.doesNotMatch(source, /applicant_email/);
  assert.deepEqual(mapSchoolAdminRequests([{ user_id: "123", applicant_first_name: "bad" }]), []);
});
