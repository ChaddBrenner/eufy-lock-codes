import test from "node:test";
import assert from "node:assert/strict";
import { loadPropertyConfig, resolveTargets } from "../src/config.mjs";
import { makeTempRoot } from "./helpers.mjs";

test("loadPropertyConfig parses property aliases, lock aliases, and code policy", () => {
  const root = makeTempRoot();
  const config = loadPropertyConfig(root);
  assert.equal(config.properties.length, 1);
  assert.equal(config.properties[0].alias, "test-house");
  assert.equal(config.properties[0].locks[0].serial, "LOCK1");
  assert.equal(config.properties[0].codePolicy.maxLength, 8);
});

test("resolveTargets enriches configured locks with discovered lock metadata", () => {
  const root = makeTempRoot();
  const config = loadPropertyConfig(root);
  const targets = resolveTargets(
    { property: "test-house", lockAlias: "front" },
    config,
    [{ serial: "LOCK1", name: "Front Door Live", capabilities: { addUser: true } }]
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0].lockSerial, "LOCK1");
  assert.equal(targets[0].discovered.name, "Front Door Live");
});
