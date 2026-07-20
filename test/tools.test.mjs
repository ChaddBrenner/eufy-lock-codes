import test from "node:test";
import assert from "node:assert/strict";
import { createToolHandlers } from "../src/tools.mjs";
import { makeTempRoot, MockBackend } from "./helpers.mjs";

test("plan_create_code creates a dry-run plan and does not call backend write methods", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });

  const plan = await tools.plan_create_code({
    property: "test-house",
    username: "Maintenance",
    passcode: "987654",
    reason: "maintenance-window"
  });

  assert.equal(plan.status, "pending");
  assert.equal(plan.operationCount, 1);
  assert.equal(plan.operations[0].passcodeMasked, "****54");
  assert.equal("passcode" in plan.operations[0], false);
  assert.equal(typeof plan.confirmationToken, "string");
  assert.deepEqual(backend.calls, []);
});

test("execute_plan is the only path that performs backend writes", async () => {
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
  assert.equal(result.status, "executed");
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].method, "addUser");
  assert.equal(backend.calls[0].passcode, "987654");

  await assert.rejects(
    () => tools.execute_plan({ confirmationToken: plan.confirmationToken }),
    /Plan is not pending/
  );
});

test("plan_update_code requires an existing exact username and stays dry-run", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });

  const plan = await tools.plan_update_code({
    property: "test-house",
    username: "Old Tenant",
    passcode: "11112222",
    reason: "tenant-rotation"
  });
  assert.equal(plan.operations[0].type, "update_code");
  assert.deepEqual(backend.calls, []);

  await assert.rejects(
    () =>
      tools.plan_update_code({
        property: "test-house",
        username: "Missing Tenant",
        passcode: "11112222",
        reason: "tenant-rotation"
      }),
    /was not found/
  );
});

test("plan_rotate_codes orders replacement before delete when username changes", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });

  const plan = await tools.plan_rotate_codes({
    property: "test-house",
    oldUsername: "Old Tenant",
    newUsername: "New Tenant",
    newPasscode: "22223333",
    reason: "move-out"
  });

  assert.deepEqual(
    plan.operations.map((operation) => operation.type),
    ["create_code", "delete_code"]
  );
});

test("list_lock_codes does not print full plaintext passcodes", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend({
    users: {
      LOCK1: [
        {
          username: "Old Tenant",
          shortUserId: "0001",
          passcodes: [
            {
              passwordId: "1001",
              isPin: true,
              plaintextPasscodeAvailable: true,
              passcodeMasked: "****34"
            }
          ]
        }
      ]
    }
  });
  const tools = createToolHandlers({ backend, rootDir: root });

  const result = await tools.list_lock_codes({ property: "test-house" });
  assert.equal(result.locks[0].users[0].passcodes[0].plaintextPasscodeAvailable, true);
  assert.equal(result.locks[0].users[0].passcodes[0].passcodeMasked, "****34");
  assert.match(result.locks[0].note, /never printed/);
});
