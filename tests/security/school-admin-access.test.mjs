import test from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedApplicantNote,
  maskApplicantEmail,
  mapSchoolAdminRequests,
} from "../../supabase/functions/school-admin-access/access-controls.js";

test("accepts only the four council roles exposed by the form", () => {
  assert.equal(isAllowedApplicantNote("Председатель Ученического совета"), true);
  assert.equal(isAllowedApplicantNote("Заместитель председателя Ученического совета"), true);
  assert.equal(isAllowedApplicantNote("Секретарь Ученического совета"), true);
  assert.equal(isAllowedApplicantNote("Член Ученического совета"), true);
  assert.equal(isAllowedApplicantNote("Мой телефон +7 900 123-45-67"), false);
  assert.equal(isAllowedApplicantNote("learner@example.ru"), false);
  assert.equal(isAllowedApplicantNote("Администратор FAM"), false);
  assert.equal(isAllowedApplicantNote("Председатель Ученического совета\n@private_contact"), false);
});

test("masks applicant email before returning requests to the Council UI", () => {
  assert.equal(maskApplicantEmail("student@example.ru"), "s***@example.ru");
  assert.equal(maskApplicantEmail("invalid-address"), "Пользователь");
  assert.equal(maskApplicantEmail(null), "Пользователь");
});

test("maps RPC request_id to frontend id and minimizes applicant identifiers", () => {
  const mapped = mapSchoolAdminRequests([{
    request_id: "6e8ecb53-2fb6-42a5-9ff8-d4d4b4d5b7c9",
    user_id: "12345678-1234-4234-8234-123456789abc",
    applicant_email: "student@example.ru",
    applicant_note: "Секретарь Ученического совета",
    created_at: "2026-11-08T10:00:00Z",
  }]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, "6e8ecb53-2fb6-42a5-9ff8-d4d4b4d5b7c9");
  assert.equal(mapped[0].user_id, "12345678");
  assert.equal(mapped[0].applicant_email, "s***@example.ru");
  assert.equal(mapped[0].applicant_note, "Секретарь Ученического совета");
});

test("drops malformed RPC rows that cannot be reviewed safely", () => {
  assert.deepEqual(mapSchoolAdminRequests([{ user_id: "123", applicant_email: "bad" }]), []);
});
