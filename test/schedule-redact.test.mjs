import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSchedule, toBackendSchedule } from "../src/schedule.mjs";
import { maskPasscode, redact } from "../src/redact.mjs";

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
