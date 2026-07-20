import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { escrowPath, loadEscrow, mergeEscrowIntoUsers } from "../src/escrow.mjs";
import { createToolHandlers } from "../src/tools.mjs";
import { makeTempRoot, MockBackend } from "./helpers.mjs";

test("execute_plan stores created passcodes in local escrow without exposing plaintext", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });
  const plan = await tools.plan_create_code({
    property: "test-house",
    username: "Maintenance",
    passcode: "987654",
    reason: "maintenance-window"
  });

  const result = await tools.execute_plan({ confirmationToken: plan.confirmationToken });
  const escrow = loadEscrow(root);

  assert.equal(result.results[0].localEscrow.action, "stored");
  assert.equal(escrow.entries.length, 1);
  assert.equal(escrow.entries[0].deviceSN, "LOCK1");
  assert.equal(escrow.entries[0].username, "Maintenance");
  assert.equal(escrow.entries[0].passcode, "987654");
  assert.equal(JSON.stringify(result).includes("987654"), false);
  assert.equal(fs.statSync(escrowPath(root)).mode & 0o777, 0o600);
});

test("list_lock_codes merges matching local escrow as masked metadata only", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });
  const plan = await tools.plan_update_code({
    property: "test-house",
    username: "Old Tenant",
    passcode: "11112222",
    reason: "tenant-rotation"
  });
  await tools.execute_plan({ confirmationToken: plan.confirmationToken });

  const result = await tools.list_lock_codes({ property: "test-house" });
  const passcode = result.locks[0].users[0].passcodes[0];

  assert.equal(passcode.localEscrowAvailable, true);
  assert.equal(passcode.passcodeKnown, true);
  assert.equal(passcode.plaintextStatus, "known-local-escrow");
  assert.deepEqual(passcode.passcodeSources, ["local-escrow"]);
  assert.equal(passcode.passcodeMasked, "******22");
  assert.equal(JSON.stringify(result).includes("11112222"), false);
});

test("delete execution removes matching local escrow entry", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });
  const updatePlan = await tools.plan_update_code({
    property: "test-house",
    username: "Old Tenant",
    passcode: "11112222",
    reason: "tenant-rotation"
  });
  await tools.execute_plan({ confirmationToken: updatePlan.confirmationToken });
  assert.equal(loadEscrow(root).entries.length, 1);

  const deletePlan = await tools.plan_delete_code({
    property: "test-house",
    username: "Old Tenant",
    reason: "move-out"
  });
  const result = await tools.execute_plan({ confirmationToken: deletePlan.confirmationToken });

  assert.equal(result.results[0].localEscrow.action, "removed");
  assert.equal(loadEscrow(root).entries.length, 0);
});

test("mergeEscrowIntoUsers annotates cloud-known and unknown passcodes", () => {
  const root = makeTempRoot();
  const users = [
    {
      username: "Cloud Known",
      passcodes: [{ passwordId: "0001", plaintextPasscodeAvailable: true, passcodeMasked: "****12" }]
    },
    {
      username: "Unknown",
      passcodes: [{ passwordId: "0002", plaintextPasscodeAvailable: false }]
    }
  ];

  const result = mergeEscrowIntoUsers(root, "LOCK1", users);

  assert.equal(result[0].passcodes[0].plaintextStatus, "known-eufy-cloud");
  assert.deepEqual(result[0].passcodes[0].passcodeSources, ["eufy-cloud"]);
  assert.equal(result[1].passcodes[0].plaintextStatus, "unknown");
  assert.deepEqual(result[1].passcodes[0].passcodeSources, []);
});
