import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSchedule, toBackendSchedule } from "../src/schedule.mjs";
import { maskPasscode, redact, safeError } from "../src/redact.mjs";

test("normalizeSchedule accepts aliases and weekday arrays", () => {
  const schedule = normalizeSchedule({
    startsAt: "2026-08-01T12:00:00-04:00",
    endsAt: "2026-08-02T12:00:00-04:00",
    week: ["monday", "friday"]
  });
  assert.equal(schedule.week.monday, true);
  assert.equal(schedule.week.friday, true);
  assert.equal(schedule.week.sunday, false);
  assert.ok(schedule.startDateTime.endsWith("Z"));
  assert.ok(toBackendSchedule(schedule).startDateTime instanceof Date);
});

test("redaction masks passcodes and secret-ish keys", () => {
  assert.equal(maskPasscode("123456"), "****56");
  assert.deepEqual(redact({ passcode: "123456", token: "abc", nested: { eufy_pass: "secret" } }), {
    passcode: "****56",
    token: "[redacted]",
    nested: {
      eufy_pass: "[redacted]"
    }
  });
});

test("safeError redacts serials, emails, tokens, and labeled passcodes in messages", () => {
  const error = new Error(
    "Failed for user@example.com on T1234EXAMPLE99 with passcode=123456 and token gho_abcdefghijklmnop"
  );
  const result = safeError(error);

  assert.equal(result.message.includes("chadd@example.com"), false);
  assert.equal(result.message.includes("T1234EXAMPLE99"), false);
  assert.equal(result.message.includes("123456"), false);
  assert.equal(result.message.includes("gho_abcdefghijklmnop"), false);
  assert.match(result.message, /\[redacted-email\]/);
  assert.match(result.message, /\[redacted-serial\]/);
  assert.match(result.message, /\[redacted-passcode\]/);
  assert.match(result.message, /\[redacted-token\]/);
});
