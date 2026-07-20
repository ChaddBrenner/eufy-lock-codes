import { loadEnv } from "./env.mjs";
import { loadPropertyConfig, resolveTargets, listConfiguredLocks } from "./config.mjs";
import { validatePasscode, publicOperation } from "./passcodes.mjs";
import { normalizeSchedule } from "./schedule.mjs";
import { claimPlan, cleanupExpiredPlans, createPlan, markPlan, publicPlan, appendAudit } from "./plan-store.mjs";
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

function findExactUser(users, username) {
  const matches = users.filter((user) => user.username === username);
  if (matches.length !== 1) return undefined;
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

function publicLock(lock, { includeLocationMetadata = false } = {}) {
  return {
    serial: lock.serial,
    name: lock.name,
    model: lock.model,
    deviceType: lock.deviceType,
    stationSerial: lock.stationSerial,
    capabilities: lock.capabilities,
    supportsCodeCrud: lock.supportsCodeCrud,
    lockKinds: lock.lockKinds,
    ...(includeLocationMetadata ? { eufyHouseName: lock.eufyHouseName } : {})
  };
}

function targetSummary(targets) {
  return targets.map((target) => `${target.propertyAlias ?? "unmapped"}:${target.lockName} (${target.lockSerial})`);
}

async function getTargets({ backend, rootDir, configPath, input }) {
  cleanupExpiredPlans(rootDir);
  const config = loadPropertyConfig(rootDir, configPath);
  const locks = await backend.discoverLocks();
  const targets = resolveTargets(input, config, locks);
  if (targets.length === 0) throw new Error("No target locks matched the request");
  return { config, locks, targets };
}

function makePlan(rootDir, { type, reason, summary, operations }) {
  cleanupExpiredPlans(rootDir);
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

function normalizedScheduleOrUndefined(schedule, { requireFields = false } = {}) {
  const normalized = normalizeSchedule(schedule);
  if (normalized && Object.keys(normalized).length === 0) {
    if (requireFields) throw new Error("schedule update must include at least one schedule field");
    return undefined;
  }
  return normalized;
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

function hasScheduleMetadata(user) {
  return (user?.passcodes ?? []).some((passcode) => {
    if (Number(passcode.expirationTime) > 0) return true;
    if (!passcode.schedule || typeof passcode.schedule !== "object") return false;
    return Object.keys(passcode.schedule).length > 0;
  });
}

function pinPasswordIds(user) {
  return (user?.passcodes ?? [])
    .filter((passcode) => passcode.isPin !== false)
    .map((passcode) => passcode.passwordId)
    .filter(Boolean)
    .map(String);
}

function userIdentity(user) {
  return {
    ...(user?.shortUserId ? { shortUserId: String(user.shortUserId) } : {}),
    ...(user?.userId ? { userId: String(user.userId) } : {})
  };
}

function assertExpectedUser(user, operation) {
  if (!operation.expectedUser) return;
  if (
    operation.expectedUser.shortUserId &&
    String(user.shortUserId) !== String(operation.expectedUser.shortUserId)
  ) {
    throw new Error(`User ${operation.username} identity changed on lock ${operation.deviceSN}`);
  }
  if (operation.expectedUser.userId && String(user.userId) !== String(operation.expectedUser.userId)) {
    throw new Error(`User ${operation.username} identity changed on lock ${operation.deviceSN}`);
  }
}

function hexByte(value) {
  return Number(value).toString(16).padStart(2, "0");
}

function expectedEufyDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  const year = date.getFullYear();
  return `${hexByte(year & 0xff)}${hexByte(year >> 8)}${hexByte(date.getMonth() + 1)}${hexByte(date.getDate())}`;
}

function expectedEufyTime(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return `${hexByte(date.getHours())}${hexByte(date.getMinutes())}`;
}

function scheduleMatchesRequested(actual, requested) {
  if (!actual || typeof actual !== "object" || !requested) return false;
  const comparisons = [
    ["startDay", expectedEufyDate(requested.startDateTime)],
    ["endDay", expectedEufyDate(requested.endDateTime)],
    ["startTime", expectedEufyTime(requested.startDateTime)],
    ["endTime", expectedEufyTime(requested.endDateTime)]
  ].filter(([, expected]) => expected);
  if (comparisons.length === 0) return hasScheduleMetadata({ passcodes: [{ schedule: actual }] });
  return comparisons.every(([field, expected]) => String(actual[field] ?? "").toLowerCase() === expected);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyOperationAppliedOnce(backend, operation) {
  const users = await backend.getLockUsers(operation.deviceSN);
  const checkedAt = new Date().toISOString();
  if (operation.type === "delete_code") {
    if (findExactUser(users, operation.username)) {
      throw new Error(`User ${operation.username} was still present on lock ${operation.deviceSN} after delete`);
    }
    return {
      checkedAt,
      userPresent: false
    };
  }

  const user = exactUser(users, operation.username, operation.deviceSN);
  assertExpectedUser(user, operation);
  const verification = {
    checkedAt,
    userPresent: true,
    passcodeMetadataCount: (user.passcodes ?? []).length
  };
  if (operation.schedule !== undefined) {
    verification.scheduleMetadataPresent = hasScheduleMetadata(user);
    if (!verification.scheduleMetadataPresent) {
      throw new Error(`User ${operation.username} on lock ${operation.deviceSN} did not expose schedule metadata after update`);
    }
    verification.scheduleMatchesRequested = (user.passcodes ?? []).some((passcode) =>
      scheduleMatchesRequested(passcode.schedule, operation.schedule)
    );
    if (!verification.scheduleMatchesRequested) {
      throw new Error(`User ${operation.username} on lock ${operation.deviceSN} did not expose the requested schedule after update`);
    }
    verification.scheduleVerification = "requested-schedule-metadata-present";
  }
  if (operation.passcode !== undefined) {
    verification.passcodeVerification = "acknowledgement-plus-final-user-presence";
    if (operation.expectedPinPasswordIds?.length > 0) {
      const actualPinIds = new Set(pinPasswordIds(user));
      const matched = operation.expectedPinPasswordIds.some((passwordId) => actualPinIds.has(String(passwordId)));
      if (!matched) {
        throw new Error(`User ${operation.username} on lock ${operation.deviceSN} did not expose the expected PIN entry after update`);
      }
      verification.expectedPinEntryPresent = true;
    }
  }
  return verification;
}

async function verifyOperationApplied(backend, operation, { timeoutMs = 45_000, intervalMs = 2_500 } = {}) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await verifyOperationAppliedOnce(backend, operation);
    } catch (error) {
      lastError = error;
      await wait(intervalMs);
    }
  }
  throw lastError ?? new Error(`Timed out verifying ${operation.type} for ${operation.username} on ${operation.deviceSN}`);
}

async function compensateCreatedUsers({ backend, rootDir, appliedCreates, results, planId, verificationOptions }) {
  const compensations = [];
  const created = [...appliedCreates].reverse();
  const seen = new Set();
  for (const operation of created) {
    const key = `${operation.deviceSN}:${operation.username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await backend.deleteUser(operation.deviceSN, operation.username);
      const verified = await verifyOperationApplied(
        backend,
        {
          type: "delete_code",
          deviceSN: operation.deviceSN,
          username: operation.username
        },
        verificationOptions
      );
      const localEscrow = removeEscrowEntry(rootDir, operation, { planId, compensation: true });
      compensations.push({
        type: "delete_created_user",
        deviceSN: operation.deviceSN,
        username: operation.username,
        status: "verified",
        verification: verified,
        localEscrow
      });
    } catch (error) {
      try {
        const verification = await verifyOperationApplied(
          backend,
          {
            type: "delete_code",
            deviceSN: operation.deviceSN,
            username: operation.username
          },
          verificationOptions
        );
        const localEscrow = removeEscrowEntry(rootDir, operation, { planId, compensation: true });
        compensations.push({
          type: "delete_created_user",
          deviceSN: operation.deviceSN,
          username: operation.username,
          status: "already_absent",
          verification,
          localEscrow,
          originalError: safeError(error)
        });
      } catch {
        compensations.push({
          type: "delete_created_user",
          deviceSN: operation.deviceSN,
          username: operation.username,
          status: "failed",
          error: safeError(error)
        });
      }
    }
  }
  return compensations;
}

export function createToolHandlers({
  backend,
  rootDir = process.cwd(),
  configPath = "config/properties.local.yaml",
  verification = {}
}) {
  return {
    async discover_locks(input = {}) {
      cleanupExpiredPlans(rootDir);
      const locks = await backend.discoverLocks();
      return {
        count: locks.length,
        locks: locks.map((lock) => publicLock(lock, input))
      };
    },

    async health_check() {
      const cleanup = cleanupExpiredPlans(rootDir);
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
        mappedLocks: [],
        localMaintenance: {
          expiredPlans: cleanup.expired,
          interruptedPlans: cleanup.interrupted,
          removedPendingSecrets: cleanup.removedSecrets
        }
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
            found: Boolean(discovered),
            capabilities: discovered?.capabilities
          };
        });
        result.ok =
          result.credentials.present &&
          result.backend.ok &&
          configuredLocks.length > 0 &&
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
      const schedule = normalizedScheduleOrUndefined(input.schedule);
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
      if (Object.prototype.hasOwnProperty.call(input, "schedule") && input.schedule === null) {
        throw new Error("schedule cannot be null for an update; omit it to leave schedule unchanged");
      }
      if (!hasPasscode && !isScheduleUpdate(input)) throw new Error("Provide passcode, schedule, or both");
      const passcode = hasPasscode ? validatePasscode(input.passcode, buildCodePolicy(targets)) : undefined;
      const schedule = isScheduleUpdate(input)
        ? normalizedScheduleOrUndefined(input.schedule, { requireFields: !hasPasscode })
        : undefined;

      const operations = [];
      for (const target of targets) {
        requireCapabilities(target, [
          ...(passcode ? ["updatePasscode"] : []),
          ...(schedule ? ["updateSchedule"] : [])
        ]);
        const users = await backend.getLockUsers(target.lockSerial);
        const user = exactUser(users, username, target.lockSerial);
        operations.push({
          type: "update_code",
          ...targetForOperation(target),
          username,
          passcode,
          schedule,
          expectedPinPasswordIds: passcode ? pinPasswordIds(user) : undefined,
          expectedUser: userIdentity(user),
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
        const user = exactUser(users, username, target.lockSerial);
        operations.push({
          type: "delete_code",
          ...targetForOperation(target),
          username,
          expectedUser: userIdentity(user),
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
      const schedule = normalizedScheduleOrUndefined(input.schedule);

      const operations = [];
      for (const target of targets) {
        requireCapabilities(target, oldUsername === newUsername ? ["updatePasscode"] : ["addUser", "deleteUser"]);
        const users = await backend.getLockUsers(target.lockSerial);
        const oldUser = exactUser(users, oldUsername, target.lockSerial);
        if (newUsername === oldUsername) {
          operations.push({
            type: "update_code",
            ...targetForOperation(target),
            username: oldUsername,
            passcode,
            schedule,
            expectedPinPasswordIds: pinPasswordIds(oldUser),
            expectedUser: userIdentity(oldUser),
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
            expectedUser: userIdentity(oldUser),
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
      cleanupExpiredPlans(rootDir);
      const token = String(input.confirmationToken ?? input.token ?? "").trim();
      if (!token) throw new Error("confirmationToken is required");
      const plan = claimPlan(rootDir, token);
      const results = [];
      const appliedCreates = [];

      try {
        for (const operation of plan.operations) {
          let localEscrow;
          if (operation.type === "create_code") {
            try {
              await backend.addUser(operation.deviceSN, operation.username, operation.passcode, operation.schedule);
              appliedCreates.push(operation);
            } catch (error) {
              if (error?.mayHaveApplied) appliedCreates.push(operation);
              throw error;
            }
            localEscrow = upsertEscrowPasscode(rootDir, operation, { planId: plan.id });
          } else if (operation.type === "update_code") {
            if (operation.passcode !== undefined) {
              await backend.updateUserPasscode(
                operation.deviceSN,
                operation.username,
                operation.passcode,
                operation.expectedUser
              );
              localEscrow = upsertEscrowPasscode(rootDir, operation, { planId: plan.id });
            }
            if (operation.schedule !== undefined) {
              await backend.updateUserSchedule(
                operation.deviceSN,
                operation.username,
                operation.schedule,
                operation.expectedUser
              );
              localEscrow = updateEscrowSchedule(rootDir, operation, { planId: plan.id });
            }
          } else if (operation.type === "delete_code") {
            await backend.deleteUser(operation.deviceSN, operation.username, operation.expectedUser);
            localEscrow = removeEscrowEntry(rootDir, operation, { planId: plan.id });
          } else {
            throw new Error(`Unknown operation type: ${operation.type}`);
          }
          const operationVerification = await verifyOperationApplied(backend, operation, verification);
          results.push({
            type: operation.type,
            deviceSN: operation.deviceSN,
            username: operation.username,
            status: "verified",
            verification: operationVerification,
            localEscrow
          });
        }
        const executionResult = publicExecutionResult(plan, results);
        markPlan(rootDir, token, "executed", executionResult);
        return executionResult;
      } catch (error) {
        const compensations = await compensateCreatedUsers({
          backend,
          rootDir,
          appliedCreates,
          results,
          planId: plan.id,
          verificationOptions: verification
        });
        const failure = {
          status: "failed",
          error: safeError(error),
          partialResults: results,
          compensations,
          remediationRequired: compensations.some((item) => item.status === "failed") || results.length > 0
        };
        markPlan(rootDir, token, "failed", failure);
        appendAudit(rootDir, { action: "execute_failed", planId: plan.id, failure });
        throw error;
      }
    }
  };
}
