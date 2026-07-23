#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EufyLockBackend } from "../src/backend/eufy-adapter.mjs";
import { listConfiguredLocks, loadPropertyConfig, resolveTargets } from "../src/config.mjs";
import { loadEscrow } from "../src/escrow.mjs";
import { maskPasscode } from "../src/redact.mjs";
import { createToolHandlers } from "../src/tools.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const args = {
    property: process.env.EUFY_LIVE_TEST_PROPERTY,
    lockAlias: process.env.EUFY_LIVE_TEST_LOCK_ALIAS,
    lockSerial: process.env.EUFY_LIVE_TEST_LOCK_SERIAL,
    confirmed: process.env.EUFY_CONFIRM_LIVE_WRITE === "1"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--property") args.property = argv[++index];
    else if (item === "--lock-alias") args.lockAlias = argv[++index];
    else if (item === "--lock-serial") args.lockSerial = argv[++index];
    else if (item === "--yes-live-write") args.confirmed = true;
  }
  return args;
}

function requireLiveWriteConfirmation(args) {
  if (args.confirmed) return;
  throw new Error("Refusing live lock-code writes without --yes-live-write or EUFY_CONFIRM_LIVE_WRITE=1");
}

function targetInput(args) {
  if (args.lockSerial) return { lockSerial: args.lockSerial };
  if (args.property) {
    return {
      property: args.property,
      ...(args.lockAlias ? { lockAlias: args.lockAlias } : {})
    };
  }
  throw new Error("Provide EUFY_LIVE_TEST_PROPERTY plus EUFY_LIVE_TEST_LOCK_ALIAS, or EUFY_LIVE_TEST_LOCK_SERIAL");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function userByName(users, username) {
  return users.find((user) => user.username === username);
}

function flattenKnownPasscodesFromInventory(inventory) {
  if (!inventory?.results) return new Set();
  return new Set(
    inventory.results
      .flatMap((lock) => lock.codes ?? [])
      .map((code) => code.passcode)
      .filter(Boolean)
      .map(String)
  );
}

async function latestMergedInventory() {
  const backupDir = path.join(rootDir, "data", "backups");
  const files = await fs.readdir(backupDir).catch(() => []);
  const latest = files
    .filter((file) => /^merged-lock-code-inventory-.*\.json$/.test(file))
    .sort()
    .pop();
  if (!latest) return undefined;
  return JSON.parse(await fs.readFile(path.join(backupDir, latest), "utf8"));
}

async function randomPasscode(knownPasscodes) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = String(crypto.randomInt(10_000_000, 100_000_000));
    if (!knownPasscodes.has(value)) return value;
  }
  throw new Error("Could not generate a non-duplicate-looking passcode");
}

function summarizeUsers(users) {
  return users.map((user) => ({
    username: user.username,
    shortUserId: user.shortUserId,
    passcodes: (user.passcodes ?? []).map((passcode) => ({
      passwordId: passcode.passwordId,
      passwordType: passcode.passwordType,
      isPin: passcode.isPin,
      label: passcode.label,
      isPermanent: passcode.isPermanent,
      expirationTime: passcode.expirationTime,
      plaintextPasscodeAvailable: passcode.plaintextPasscodeAvailable,
      passcodeMasked: passcode.passcodeMasked,
      schedule: passcode.schedule
    }))
  }));
}

function publicPlanSummary(plan) {
  return {
    id: plan.id,
    status: plan.status,
    summary: plan.summary,
    operationCount: plan.operationCount,
    operations: plan.operations
  };
}

function publicExecutionSummary(result) {
  return {
    planId: result.planId,
    status: result.status,
    operationCount: result.operationCount,
    operations: result.operations,
    results: result.results
  };
}

async function saveArtifact(name, data) {
  const backupDir = path.join(rootDir, "data", "backups");
  const outPath = path.join(backupDir, `${name}-${stamp()}.json`);
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  await fs.chmod(backupDir, 0o700);
  await fs.writeFile(outPath, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.chmod(outPath, 0o600);
  return outPath;
}

function parseSchedule(schedule) {
  if (!schedule) return undefined;
  if (typeof schedule === "object") return schedule;
  try {
    return JSON.parse(schedule);
  } catch {
    return undefined;
  }
}

function hasBoundedExpiration(user) {
  const passcode = (user?.passcodes ?? [])[0];
  const schedule = parseSchedule(passcode?.schedule);
  if (!passcode) return false;
  if (Number(passcode.expirationTime) > 0) return true;
  if (!schedule) return false;
  if (schedule.endDateTime) return true;
  if (Number(schedule.endDate) > 0) return true;
  if (schedule.endDay && String(schedule.endDay).toLowerCase() !== "ffffffff") return true;
  return false;
}

async function resolveLiveTarget({ backend, input }) {
  const config = loadPropertyConfig(rootDir);
  const locks = await backend.discoverLocks();
  const targets = resolveTargets(input, config, locks);
  if (targets.length !== 1) {
    throw new Error(`Live CRUD verification requires exactly one target lock; resolved ${targets.length}`);
  }
  const configuredLocks = listConfiguredLocks(config);
  if (configuredLocks.length === 0) throw new Error("No configured locks found in config/properties.local.yaml");
  return targets[0];
}

async function pollRawUsers(backend, target, predicate, { timeoutMs = 90_000, intervalMs = 3_000, description }) {
  const start = Date.now();
  let latestUsers = [];
  while (Date.now() - start <= timeoutMs) {
    latestUsers = await backend.getLockUsers(target.lockSerial);
    if (predicate(latestUsers)) return latestUsers;
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function deleteIfPresent({ handlers, backend, input, target, username, results }) {
  const users = await backend.getLockUsers(target.lockSerial);
  if (!userByName(users, username)) {
    results.cleanup.push({ username, action: "not-present" });
    return;
  }
  const plan = await handlers.plan_delete_code({
    ...input,
    username,
    reason: "cleanup live MCP CRUD verification code"
  });
  const execution = await handlers.execute_plan({ confirmationToken: plan.confirmationToken });
  await pollRawUsers(backend, target, (latestUsers) => !userByName(latestUsers, username), {
    description: `${username} to be deleted`
  });
  results.cleanup.push({
    username,
    action: "deleted",
    plan: publicPlanSummary(plan),
    execution: publicExecutionSummary(execution)
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireLiveWriteConfirmation(args);
  const input = targetInput(args);
  const suffix = Date.now().toString(36).slice(-5).toUpperCase();
  const tempUsername = `McpTmp${suffix}`;
  const scheduledUsername = `McpSch${suffix}`;
  const knownPasscodes = flattenKnownPasscodesFromInventory(await latestMergedInventory());
  const tempPasscode = await randomPasscode(knownPasscodes);
  knownPasscodes.add(tempPasscode);
  const updatedPasscode = await randomPasscode(knownPasscodes);
  knownPasscodes.add(updatedPasscode);
  const scheduledPasscode = await randomPasscode(knownPasscodes);
  const scheduleStart = new Date(Date.now() + 5 * 60 * 1000);
  const scheduleEnd = new Date(Date.now() + 65 * 60 * 1000);
  const backend = new EufyLockBackend({ rootDir });
  const handlers = createToolHandlers({ backend, rootDir });
  const target = await resolveLiveTarget({ backend, input });
  const results = {
    target: {
      propertyAlias: target.propertyAlias,
      lockName: target.lockName,
      lockSerial: target.lockSerial
    },
    startedAt: new Date().toISOString(),
    testUsers: [
      {
        username: tempUsername,
        passcodeMasked: maskPasscode(tempPasscode),
        updatedPasscodeMasked: maskPasscode(updatedPasscode),
        kind: "temporary-create-update-delete"
      },
      {
        username: scheduledUsername,
        passcodeMasked: maskPasscode(scheduledPasscode),
        kind: "scheduled-expiring",
        schedule: {
          startDateTime: scheduleStart.toISOString(),
          endDateTime: scheduleEnd.toISOString()
        }
      }
    ],
    phases: [],
    cleanup: []
  };

  try {
    const beforeUsers = await backend.getLockUsers(target.lockSerial);
    results.beforeUserCount = beforeUsers.length;
    results.beforeBackup = await saveArtifact("live-crud-before", {
      target: results.target,
      capturedAt: new Date().toISOString(),
      users: summarizeUsers(beforeUsers)
    });

    const tempPlan = await handlers.plan_create_code({
      ...input,
      username: tempUsername,
      passcode: tempPasscode,
      reason: "live MCP CRUD verification temporary code"
    });
    const tempExecution = await handlers.execute_plan({ confirmationToken: tempPlan.confirmationToken });
    await pollRawUsers(backend, target, (users) => Boolean(userByName(users, tempUsername)), {
      description: `${tempUsername} to appear`
    });
    results.phases.push({
      name: "create-temporary-code",
      status: "verified",
      plan: publicPlanSummary(tempPlan),
      execution: publicExecutionSummary(tempExecution)
    });

    const updatePlan = await handlers.plan_update_code({
      ...input,
      username: tempUsername,
      passcode: updatedPasscode,
      reason: "live MCP CRUD verification update temporary code"
    });
    const updateExecution = await handlers.execute_plan({ confirmationToken: updatePlan.confirmationToken });
    await pollRawUsers(backend, target, (users) => Boolean(userByName(users, tempUsername)), {
      description: `${tempUsername} to remain present after update`
    });
    const updatedEscrow = loadEscrow(rootDir).entries.find(
      (entry) => entry.deviceSN === target.lockSerial && entry.username === tempUsername
    );
    if (updatedEscrow?.passcode !== updatedPasscode) {
      throw new Error(`Local escrow did not record updated passcode for ${tempUsername}`);
    }
    results.phases.push({
      name: "update-temporary-code",
      status: "verified",
      plan: publicPlanSummary(updatePlan),
      execution: publicExecutionSummary(updateExecution),
      escrow: {
        username: tempUsername,
        passcodeMasked: maskPasscode(updatedEscrow.passcode),
        lastOperation: updatedEscrow.lastOperation,
        updatedAt: updatedEscrow.updatedAt
      }
    });

    await deleteIfPresent({ handlers, backend, input, target, username: tempUsername, results });
    results.phases.push({
      name: "delete-temporary-code",
      status: "verified"
    });

    const scheduledPlan = await handlers.plan_create_code({
      ...input,
      username: scheduledUsername,
      passcode: scheduledPasscode,
      schedule: {
        startDateTime: scheduleStart.toISOString(),
        endDateTime: scheduleEnd.toISOString()
      },
      reason: "live MCP CRUD verification scheduled expiring code"
    });
    const scheduledExecution = await handlers.execute_plan({ confirmationToken: scheduledPlan.confirmationToken });
    const scheduledUsers = await pollRawUsers(
      backend,
      target,
      (users) => {
        const user = userByName(users, scheduledUsername);
        return Boolean(user && hasBoundedExpiration(user));
      },
      { description: `${scheduledUsername} to appear with a bounded expiration` }
    );
    results.phases.push({
      name: "create-scheduled-expiring-code",
      status: "verified",
      plan: publicPlanSummary(scheduledPlan),
      execution: publicExecutionSummary(scheduledExecution),
      verifiedUser: summarizeUsers([userByName(scheduledUsers, scheduledUsername)])[0]
    });

    const escrowDuringTest = loadEscrow(rootDir).entries.filter(
      (entry) => entry.deviceSN === target.lockSerial && [tempUsername, scheduledUsername].includes(entry.username)
    );
    results.phases.push({
      name: "local-escrow",
      status: "verified",
      entries: escrowDuringTest.map((entry) => ({
        username: entry.username,
        passcodeMasked: maskPasscode(entry.passcode),
        lastOperation: entry.lastOperation,
        updatedAt: entry.updatedAt
      }))
    });
  } finally {
    try {
      await deleteIfPresent({ handlers, backend, input, target, username: tempUsername, results });
    } catch (error) {
      results.cleanup.push({ username: tempUsername, action: "failed", error: error?.message ?? String(error) });
    }
    try {
      await deleteIfPresent({ handlers, backend, input, target, username: scheduledUsername, results });
    } catch (error) {
      results.cleanup.push({ username: scheduledUsername, action: "failed", error: error?.message ?? String(error) });
    }

    try {
      const afterUsers = await backend.getLockUsers(target.lockSerial);
      results.afterUserCount = afterUsers.length;
      results.afterBackup = await saveArtifact("live-crud-after", {
        target: results.target,
        capturedAt: new Date().toISOString(),
        users: summarizeUsers(afterUsers)
      });
      results.testUsersRemaining = [tempUsername, scheduledUsername].filter((username) => userByName(afterUsers, username));
    } finally {
      await backend.close();
    }

    results.finishedAt = new Date().toISOString();
    results.report = await saveArtifact("live-crud-report", results);
    console.log(
      JSON.stringify(
        {
          target: `${results.target.propertyAlias}:${results.target.lockName}`,
          report: results.report,
          beforeBackup: results.beforeBackup,
          afterBackup: results.afterBackup,
          phases: results.phases.map((phase) => ({ name: phase.name, status: phase.status })),
          cleanup: results.cleanup.map((item) => ({ username: item.username, action: item.action })),
          testUsersRemaining: results.testUsersRemaining
        },
        null,
        2
      )
    );
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(JSON.stringify({ error: error?.message ?? String(error) }, null, 2));
    process.exit(1);
  });
