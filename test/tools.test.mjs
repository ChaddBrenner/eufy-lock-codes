import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createToolHandlers } from "../src/tools.mjs";
import { loadEscrow } from "../src/escrow.mjs";
import { claimPlan } from "../src/plan-store.mjs";
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

test("stored plan files do not retain plaintext passcodes", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });
  const plan = await tools.plan_create_code({
    property: "test-house",
    username: "Maintenance",
    passcode: "987654",
    reason: "maintenance-window"
  });

  const planFiles = fs.readdirSync(path.join(root, "data", "plans"));
  assert.equal(planFiles.length, 1);
  const planText = fs.readFileSync(path.join(root, "data", "plans", planFiles[0]), "utf8");
  assert.equal(planText.includes("987654"), false);
  assert.equal(planText.includes("****54"), true);

  await tools.execute_plan({ confirmationToken: plan.confirmationToken });
  const completedPlanText = fs.readFileSync(path.join(root, "data", "plans", planFiles[0]), "utf8");
  assert.equal(completedPlanText.includes("987654"), false);
  assert.equal(fs.existsSync(path.join(root, "data", "pending-plan-secrets", `${plan.confirmationToken}.json`)), false);
});

test("expired plans remove pending plaintext secrets during maintenance", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });
  const plan = await tools.plan_create_code({
    property: "test-house",
    username: "Maintenance",
    passcode: "987654",
    reason: "maintenance-window"
  });
  const planFile = path.join(root, "data", "plans", `${plan.confirmationToken}.json`);
  const secretFile = path.join(root, "data", "pending-plan-secrets", `${plan.confirmationToken}.json`);
  const storedPlan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  fs.writeFileSync(
    planFile,
    JSON.stringify({ ...storedPlan, expiresAt: new Date(Date.now() - 1_000).toISOString() }, null, 2)
  );
  assert.equal(fs.existsSync(secretFile), true);

  await tools.health_check();

  const expiredPlan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  assert.equal(expiredPlan.status, "expired");
  assert.equal(fs.existsSync(secretFile), false);
});

test("stale executing plans are marked interrupted during maintenance", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });
  const plan = await tools.plan_create_code({
    property: "test-house",
    username: "Maintenance",
    passcode: "987654",
    reason: "maintenance-window"
  });
  claimPlan(root, plan.confirmationToken);
  const planFile = path.join(root, "data", "plans", `${plan.confirmationToken}.json`);
  const storedPlan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  fs.writeFileSync(
    planFile,
    JSON.stringify(
      {
        ...storedPlan,
        claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      },
      null,
      2
    )
  );

  const health = await tools.health_check();

  const interruptedPlan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  assert.equal(interruptedPlan.status, "interrupted");
  assert.equal(interruptedPlan.result.remediationRequired, true);
  assert.equal(health.localMaintenance.interruptedPlans, 1);
});

test("confirmation token execution is atomic under concurrent callers", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });
  const plan = await tools.plan_create_code({
    property: "test-house",
    username: "Maintenance",
    passcode: "987654",
    reason: "maintenance-window"
  });

  const settled = await Promise.allSettled([
    tools.execute_plan({ confirmationToken: plan.confirmationToken }),
    tools.execute_plan({ confirmationToken: plan.confirmationToken })
  ]);

  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  assert.equal(backend.calls.filter((call) => call.method === "addUser").length, 1);
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

test("plan_update_code rejects null or empty schedule-only updates", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });

  await assert.rejects(
    () =>
      tools.plan_update_code({
        property: "test-house",
        username: "Old Tenant",
        schedule: null,
        reason: "tenant-rotation"
      }),
    /schedule cannot be null/
  );

  await assert.rejects(
    () =>
      tools.plan_update_code({
        property: "test-house",
        username: "Old Tenant",
        schedule: {},
        reason: "tenant-rotation"
      }),
    /schedule update must include/
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

test("execute_plan compensates created users after later rotation failure", async () => {
  const root = makeTempRoot();
  class DeleteOldFailsBackend extends MockBackend {
    async deleteUser(deviceSN, username, expectedUser) {
      if (username === "Old Tenant") throw new Error("delete old failed");
      return super.deleteUser(deviceSN, username, expectedUser);
    }
  }
  const backend = new DeleteOldFailsBackend();
  const tools = createToolHandlers({ backend, rootDir: root });
  const plan = await tools.plan_rotate_codes({
    property: "test-house",
    oldUsername: "Old Tenant",
    newUsername: "New Tenant",
    newPasscode: "22223333",
    reason: "move-out"
  });

  await assert.rejects(() => tools.execute_plan({ confirmationToken: plan.confirmationToken }), /delete old failed/);

  const users = await backend.getLockUsers("LOCK1");
  assert.equal(Boolean(users.find((user) => user.username === "Old Tenant")), true);
  assert.equal(Boolean(users.find((user) => user.username === "New Tenant")), false);
  assert.equal(loadEscrow(root).entries.some((entry) => entry.username === "New Tenant"), false);
  assert.deepEqual(
    backend.calls.map((call) => `${call.method}:${call.username}`),
    ["addUser:New Tenant", "deleteUser:New Tenant"]
  );
});

test("execute_plan compensates when create succeeds but verification fails", async () => {
  const root = makeTempRoot();
  class CreateVerificationMissBackend extends MockBackend {
    constructor() {
      super();
      this.hideMaintenance = false;
    }

    async addUser(deviceSN, username, passcode, schedule) {
      await super.addUser(deviceSN, username, passcode, schedule);
      if (username === "Maintenance") this.hideMaintenance = true;
    }

    async getLockUsers(deviceSN) {
      const users = await super.getLockUsers(deviceSN);
      return this.hideMaintenance ? users.filter((user) => user.username !== "Maintenance") : users;
    }

    async deleteUser(deviceSN, username, expectedUser) {
      this.hideMaintenance = false;
      return super.deleteUser(deviceSN, username, expectedUser);
    }
  }
  const backend = new CreateVerificationMissBackend();
  const tools = createToolHandlers({
    backend,
    rootDir: root,
    verification: { timeoutMs: 5, intervalMs: 1 }
  });
  const plan = await tools.plan_create_code({
    property: "test-house",
    username: "Maintenance",
    passcode: "987654",
    reason: "maintenance-window"
  });

  await assert.rejects(() => tools.execute_plan({ confirmationToken: plan.confirmationToken }), /was not found/);

  const users = await backend.getLockUsers("LOCK1");
  assert.equal(Boolean(users.find((user) => user.username === "Maintenance")), false);
  assert.equal(loadEscrow(root).entries.some((entry) => entry.username === "Maintenance"), false);
  assert.deepEqual(
    backend.calls.map((call) => `${call.method}:${call.username}`),
    ["addUser:Maintenance", "deleteUser:Maintenance"]
  );
});

test("execute_plan compensates when create may have applied but acknowledgement is lost", async () => {
  const root = makeTempRoot();
  class LostAckCreateBackend extends MockBackend {
    async addUser(deviceSN, username, passcode, schedule) {
      await super.addUser(deviceSN, username, passcode, schedule);
      throw Object.assign(new Error("add acknowledgement timed out"), { mayHaveApplied: true });
    }
  }
  const backend = new LostAckCreateBackend();
  const tools = createToolHandlers({
    backend,
    rootDir: root,
    verification: { timeoutMs: 5, intervalMs: 1 }
  });
  const plan = await tools.plan_create_code({
    property: "test-house",
    username: "Maintenance",
    passcode: "987654",
    reason: "maintenance-window"
  });

  await assert.rejects(
    () => tools.execute_plan({ confirmationToken: plan.confirmationToken }),
    /acknowledgement timed out/
  );

  const users = await backend.getLockUsers("LOCK1");
  assert.equal(Boolean(users.find((user) => user.username === "Maintenance")), false);
  assert.equal(loadEscrow(root).entries.some((entry) => entry.username === "Maintenance"), false);
  assert.deepEqual(
    backend.calls.map((call) => `${call.method}:${call.username}`),
    ["addUser:Maintenance", "deleteUser:Maintenance"]
  );
});

test("execute_plan refuses delete when username identity changed after planning", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({
    backend,
    rootDir: root,
    verification: { timeoutMs: 5, intervalMs: 1 }
  });
  const plan = await tools.plan_delete_code({
    property: "test-house",
    username: "Old Tenant",
    reason: "move-out"
  });
  backend.users.LOCK1[0] = {
    ...backend.users.LOCK1[0],
    shortUserId: "9999"
  };

  await assert.rejects(() => tools.execute_plan({ confirmationToken: plan.confirmationToken }), /identity changed/);

  const users = await backend.getLockUsers("LOCK1");
  assert.equal(Boolean(users.find((user) => user.username === "Old Tenant")), true);
  assert.equal(backend.calls.filter((call) => call.method === "deleteUser").length, 0);
});

test("execute_plan does not compensate a create that failed before applying", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend();
  const tools = createToolHandlers({
    backend,
    rootDir: root,
    verification: { timeoutMs: 5, intervalMs: 1 }
  });
  const plan = await tools.plan_create_code({
    property: "test-house",
    username: "Maintenance",
    passcode: "987654",
    reason: "maintenance-window"
  });
  backend.users.LOCK1.push({
    username: "Maintenance",
    shortUserId: "0042",
    passcodes: [{ passwordId: "0042", isPin: true }]
  });

  await assert.rejects(() => tools.execute_plan({ confirmationToken: plan.confirmationToken }), /already exists/);

  const users = await backend.getLockUsers("LOCK1");
  assert.equal(users.filter((user) => user.username === "Maintenance").length, 1);
  assert.deepEqual(
    backend.calls.map((call) => `${call.method}:${call.username}`),
    ["addUser:Maintenance"]
  );
});

test("discover_locks omits location metadata by default", async () => {
  const root = makeTempRoot();
  const backend = new MockBackend({
    locks: [
      {
        serial: "LOCK1",
        name: "Front Door",
        stationSerial: "STATION1",
        model: "Smart Lock",
        eufyHouseName: "Private House Label",
        capabilities: {
          addUser: true,
          deleteUser: true,
          updatePasscode: true,
          updateSchedule: true,
          queryAllUsers: true
        }
      }
    ]
  });
  const tools = createToolHandlers({ backend, rootDir: root });

  const defaultResult = await tools.discover_locks();
  assert.equal(defaultResult.locks[0].eufyHouseName, undefined);

  const explicitResult = await tools.discover_locks({ includeLocationMetadata: true });
  assert.equal(explicitResult.locks[0].eufyHouseName, "Private House Label");
});

test("health_check is not ok without configured locks", async () => {
  const root = makeTempRoot();
  fs.writeFileSync(path.join(root, "config", "properties.local.yaml"), "properties: {}\n");
  const backend = new MockBackend();
  const tools = createToolHandlers({ backend, rootDir: root });

  const result = await tools.health_check();
  assert.equal(result.config.configuredLockCount, 0);
  assert.equal(result.ok, false);
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
