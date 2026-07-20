import { loadEnv } from "./env.mjs";
import { loadPropertyConfig, resolveTargets, listConfiguredLocks } from "./config.mjs";
import { validatePasscode, publicOperation } from "./passcodes.mjs";
import { normalizeSchedule } from "./schedule.mjs";
import { createPlan, loadPlan, markPlan, publicPlan, appendAudit } from "./plan-store.mjs";
import { safeError } from "./redact.mjs";
import {
  mergeEscrowIntoUsers,
  removeEscrowEntry,
  updateEscrowSchedule,
  upsertEscrowPasscode
} from "./escrow.mjs";
import { mergeRecoveryCacheIntoUsers } from "./recovery-cache.mjs";

function exactUser(users, username, deviceSN) {
  const matches = users.filter((user) => user.username === username);
  if (matches.length === 0) throw new Error(`User ${username} was not found on lock ${deviceSN}`);
  if (matches.length > 1) throw new Error(`User ${username} is ambiguous on lock ${deviceSN}`);
  return matches[0];
}

function ensureUserAbsent(users, username, deviceSN) {
  const matches = users.filter((user) => user.username === username);
  if (matches.length > 0) throw new Error(`User ${username} already exists on lock ${deviceSN}`);
}

function requireCapabilities(target, capabilities) {
  if (!target.discovered) throw new Error(`Mapped lock was not discovered by Eufy: ${target.lockSerial}`);
  const missing = capabilities.filter((capability) => !target.discovered.capabilities?.[capability]);
  if (missing.length > 0) {
    throw new Error(`Lock ${target.lockSerial} does not support required capabilities: ${missing.join(", ")}`);
  }
}

function targetForOperation(target) {
  return {
    deviceSN: target.lockSerial,
    propertyAlias: target.propertyAlias,
    propertyName: target.propertyName,
    lockName: target.lockName
  };
}

function targetSummary(targets) {
  return targets.map((target) => `${target.propertyAlias ?? "unmapped"}:${target.lockName} (${target.lockSerial})`);
}

async function getTargets({ backend, rootDir, configPath, input }) {
  const config = loadPropertyConfig(rootDir, configPath);
  const locks = await backend.discoverLocks();
  const targets = resolveTargets(input, config, locks);
  if (targets.length === 0) throw new Error("No target locks matched the request");
  return { config, locks, targets };
}

function makePlan(rootDir, { type, reason, summary, operations }) {
  const plan = createPlan(rootDir, {
    type,
    reason,
    summary,
    operations
  });
  return publicPlan(plan);
}

function isScheduleUpdate(input) {
  return Object.prototype.hasOwnProperty.call(input, "schedule") && input.schedule !== undefined;
}

function buildCodePolicy(targets) {
  const policy = targets[0]?.codePolicy ?? {};
  for (const target of targets) {
    if (JSON.stringify(target.codePolicy ?? {}) !== JSON.stringify(policy)) {
      throw new Error("Target locks have different passcode policies; plan them separately");
    }
  }
  return policy;
}

function assertReason(reason) {
  const value = String(reason ?? "").trim();
  if (!value) throw new Error("A reason is required for lock-code write plans");
  return value;
}

function publicExecutionResult(plan, results) {
  return {
    planId: plan.id,
    status: "executed",
    operationCount: plan.operations.length,
    operations: plan.operations.map(publicOperation),
    results
  };
}

export function createToolHandlers({ backend, rootDir = process.cwd(), configPath = "config/properties.local.yaml" }) {
  return {
    async discover_locks() {
      const locks = await backend.discoverLocks();
      return {
        count: locks.length,
        locks
      };
    },

    async health_check() {
      const envStatus = loadEnv(rootDir);
      const config = loadPropertyConfig(rootDir, configPath);
      const configuredLocks = listConfiguredLocks(config);
      const result = {
        ok: false,
        credentials: {
          present: envStatus.ok,
          missing: envStatus.missing
        },
        config: {
          path: config.path,
          propertyCount: config.properties.length,
          configuredLockCount: configuredLocks.length
        },
        backend: {
          ok: false
        },
        mappedLocks: []
      };

      if (!envStatus.ok) return result;

      try {
        const locks = await backend.discoverLocks();
        const bySerial = new Map(locks.map((lock) => [lock.serial, lock]));
        result.backend = { ok: true, discoveredLockCount: locks.length };
        result.mappedLocks = configuredLocks.map((configured) => {
          const discovered = bySerial.get(configured.lockSerial);
          return {
            propertyAlias: configured.propertyAlias,
            lockName: configured.lockName,
            lockSerial: configured.lockSerial,
            eufyHouseName: discovered?.eufyHouseName,
            found: Boolean(discovered),
            capabilities: discovered?.capabilities
          };
        });
        result.ok =
          result.credentials.present &&
          result.backend.ok &&
          result.mappedLocks.every((lock) => lock.found !== false);
      } catch (error) {
        result.backend = {
          ok: false,
          error: safeError(error)
        };
      }
      return result;
    },

    async list_lock_codes(input = {}) {
      const normalizedInput = Object.keys(input).length === 0 ? { allConfigured: true } : input;
      const { targets } = await getTargets({ backend, rootDir, configPath, input: normalizedInput });
      const locks = [];
      for (const target of targets) {
        requireCapabilities(target, []);
        const users = mergeEscrowIntoUsers(
          rootDir,
          target.lockSerial,
          mergeRecoveryCacheIntoUsers(rootDir, target.lockSerial, await backend.getLockUsers(target.lockSerial))
        );
        locks.push({
          ...targetForOperation(target),
          users,
          note:
            "Full plaintext passcodes are never printed by this tool. localEscrowAvailable means this server has the plaintext stored privately under git-ignored data/. plaintextPasscodeAvailable only means Eufy returned a value; passcodeMasked shows a redacted hint."
        });
      }
      return {
        count: locks.length,
        locks
      };
    },

    async plan_create_code(input) {
      const reason = assertReason(input.reason);
      const { targets } = await getTargets({ backend, rootDir, configPath, input });
      const passcode = validatePasscode(input.passcode, buildCodePolicy(targets));
      const schedule = normalizeSchedule(input.schedule);
      const username = String(input.username ?? "").trim();
      if (!username) throw new Error("username is required");

      const operations = [];
      for (const target of targets) {
        requireCapabilities(target, ["addUser"]);
        const users = await backend.getLockUsers(target.lockSerial);
        ensureUserAbsent(users, username, target.lockSerial);
        operations.push({
          type: "create_code",
          ...targetForOperation(target),
          username,
          passcode,
          schedule,
          reason
        });
      }
      return makePlan(rootDir, {
        type: "create_code",
        reason,
        summary: `Create code for ${username} on ${operations.length} lock(s): ${targetSummary(targets).join(", ")}`,
        operations
      });
    },

    async plan_update_code(input) {
      const reason = assertReason(input.reason);
      const { targets } = await getTargets({ backend, rootDir, configPath, input });
      const username = String(input.username ?? "").trim();
      if (!username) throw new Error("username is required");
      const hasPasscode = input.passcode !== undefined && input.passcode !== null && input.passcode !== "";
      if (!hasPasscode && !isScheduleUpdate(input)) throw new Error("Provide passcode, schedule, or both");
      const passcode = hasPasscode ? validatePasscode(input.passcode, buildCodePolicy(targets)) : undefined;
      const schedule = isScheduleUpdate(input) ? normalizeSchedule(input.schedule) : undefined;

      const operations = [];
      for (const target of targets) {
        requireCapabilities(target, [
          ...(passcode ? ["updatePasscode"] : []),
          ...(schedule ? ["updateSchedule"] : [])
        ]);
        const users = await backend.getLockUsers(target.lockSerial);
        exactUser(users, username, target.lockSerial);
        operations.push({
          type: "update_code",
          ...targetForOperation(target),
          username,
          passcode,
          schedule,
          reason
        });
      }
      return makePlan(rootDir, {
        type: "update_code",
        reason,
        summary: `Update code metadata for ${username} on ${operations.length} lock(s): ${targetSummary(targets).join(", ")}`,
        operations
      });
    },

    async plan_delete_code(input) {
      const reason = assertReason(input.reason);
      const { targets } = await getTargets({ backend, rootDir, configPath, input });
      const username = String(input.username ?? "").trim();
      if (!username) throw new Error("username is required");

      const operations = [];
      for (const target of targets) {
        requireCapabilities(target, ["deleteUser"]);
        const users = await backend.getLockUsers(target.lockSerial);
        exactUser(users, username, target.lockSerial);
        operations.push({
          type: "delete_code",
          ...targetForOperation(target),
          username,
          reason
        });
      }
      return makePlan(rootDir, {
        type: "delete_code",
        reason,
        summary: `Delete code user ${username} from ${operations.length} lock(s): ${targetSummary(targets).join(", ")}`,
        operations
      });
    },

    async plan_rotate_codes(input) {
      const reason = assertReason(input.reason);
      const { targets } = await getTargets({ backend, rootDir, configPath, input });
      const oldUsername = String(input.oldUsername ?? "").trim();
      const newUsername = String(input.newUsername ?? oldUsername).trim();
      if (!oldUsername) throw new Error("oldUsername is required");
      if (!newUsername) throw new Error("newUsername is required");
      const passcode = validatePasscode(input.newPasscode ?? input.passcode, buildCodePolicy(targets));
      const schedule = normalizeSchedule(input.schedule);

      const operations = [];
      for (const target of targets) {
        requireCapabilities(target, oldUsername === newUsername ? ["updatePasscode"] : ["addUser", "deleteUser"]);
        const users = await backend.getLockUsers(target.lockSerial);
        exactUser(users, oldUsername, target.lockSerial);
        if (newUsername === oldUsername) {
          operations.push({
            type: "update_code",
            ...targetForOperation(target),
            username: oldUsername,
            passcode,
            schedule,
            reason
          });
        } else {
          ensureUserAbsent(users, newUsername, target.lockSerial);
          operations.push({
            type: "create_code",
            ...targetForOperation(target),
            username: newUsername,
            passcode,
            schedule,
            reason
          });
          operations.push({
            type: "delete_code",
            ...targetForOperation(target),
            username: oldUsername,
            reason
          });
        }
      }
      return makePlan(rootDir, {
        type: "rotate_codes",
        reason,
        summary: `Rotate ${oldUsername} to ${newUsername} across ${targets.length} lock(s): ${targetSummary(targets).join(", ")}`,
        operations
      });
    },

    async execute_plan(input) {
      const token = String(input.confirmationToken ?? input.token ?? "").trim();
      if (!token) throw new Error("confirmationToken is required");
      const plan = loadPlan(rootDir, token);
      const results = [];

      try {
        for (const operation of plan.operations) {
          let localEscrow;
          if (operation.type === "create_code") {
            await backend.addUser(operation.deviceSN, operation.username, operation.passcode, operation.schedule);
            localEscrow = upsertEscrowPasscode(rootDir, operation, { planId: plan.id });
          } else if (operation.type === "update_code") {
            if (operation.passcode !== undefined) {
              await backend.updateUserPasscode(operation.deviceSN, operation.username, operation.passcode);
              localEscrow = upsertEscrowPasscode(rootDir, operation, { planId: plan.id });
            }
            if (operation.schedule !== undefined) {
              await backend.updateUserSchedule(operation.deviceSN, operation.username, operation.schedule);
              localEscrow = updateEscrowSchedule(rootDir, operation, { planId: plan.id });
            }
          } else if (operation.type === "delete_code") {
            await backend.deleteUser(operation.deviceSN, operation.username);
            localEscrow = removeEscrowEntry(rootDir, operation, { planId: plan.id });
          } else {
            throw new Error(`Unknown operation type: ${operation.type}`);
          }
          results.push({
            type: operation.type,
            deviceSN: operation.deviceSN,
            username: operation.username,
            status: "sent",
            localEscrow
          });
        }
        const executionResult = publicExecutionResult(plan, results);
        markPlan(rootDir, token, "executed", executionResult);
        return executionResult;
      } catch (error) {
        const failure = {
          status: "failed",
          error: safeError(error),
          partialResults: results
        };
        markPlan(rootDir, token, "failed", failure);
        appendAudit(rootDir, { action: "execute_failed", planId: plan.id, failure });
        throw error;
      }
    }
  };
}
