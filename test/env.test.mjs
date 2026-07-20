import test from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../src/env.mjs";

test("loadEnv accepts existing lowercase eufy credential keys and defaults country/language", () => {
  const loaded = loadEnv(process.cwd(), {
    eufy_email: "person@example.com",
    eufy_pass: "secret"
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.config.username, "person@example.com");
  assert.equal(loaded.config.password, "secret");
  assert.equal(loaded.config.country, "US");
  assert.equal(loaded.config.language, "en");
});

test("loadEnv reports missing credential keys without exposing values", () => {
  const loaded = loadEnv(process.cwd(), {});
  assert.equal(loaded.ok, false);
  assert.deepEqual(loaded.missing, ["eufy_email", "eufy_pass"]);
});
