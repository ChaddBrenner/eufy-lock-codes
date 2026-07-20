import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publicOperation } from "./passcodes.mjs";
import { redact } from "./redact.mjs";

const PLAN_TTL_MS = 15 * 60 * 1000;
const EXECUTING_STALE_MS = 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["executed", "failed", "expired", "interrupted"]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function planDir(rootDir) {
  return path.join(rootDir, "data", "plans");
}

function planSecretDir(rootDir) {
  return path.join(rootDir, "data", "pending-plan-secrets");
}

function auditPath(rootDir) {
  return path.join(rootDir, "data", "audit", "lock-code-audit.jsonl");
}

function planPath(rootDir, token) {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) throw new Error("Invalid confirmation token format");
  return path.join(planDir(rootDir), `${token}.json`);
}

function planSecretPath(rootDir, token) {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) throw new Error("Invalid confirmation token format");
  return path.join(planSecretDir(rootDir), `${token}.json`);
}

function planLockPath(rootDir, token) {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) throw new Error("Invalid confirmation token format");
  return path.join(planDir(rootDir), `${token}.lock`);
}

export function publicPlan(plan) {
  return {
    id: plan.id,
    status: plan.status,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    summary: plan.summary,
    reason: plan.reason,
    operationCount: plan.operations.length,
    operations: plan.operations.map(publicOperation),
    confirmationToken: plan.status === "pending" ? plan.token : undefined
  };
}

export function createPlan(rootDir, planInput) {
  const token = crypto.randomBytes(24).toString("base64url");
  const now = new Date();
  const publicOperations = planInput.operations.map(publicOperation);
  const plan = {
    id: crypto.randomUUID(),
    token,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    ...planInput,
    operations: publicOperations,
    secretRef: "pending-plan-secrets"
  };
  const secrets = {
    planId: plan.id,
    operations: planInput.operations
  };
  ensureDir(planDir(rootDir));
  ensureDir(planSecretDir(rootDir));
  fs.writeFileSync(planPath(rootDir, token), JSON.stringify(plan, null, 2), { mode: 0o600 });
  fs.writeFileSync(planSecretPath(rootDir, token), JSON.stringify(secrets, null, 2), { mode: 0o600 });
  appendAudit(rootDir, { action: "plan_created", plan: publicPlan(plan) });
  return plan;
}

export function loadPlan(rootDir, token) {
  const file = planPath(rootDir, token);
  if (!fs.existsSync(file)) throw new Error("Confirmation token was not found");
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  if (plan.status !== "pending") throw new Error(`Plan is not pending; current status is ${plan.status}`);
  if (new Date(plan.expiresAt).getTime() <= Date.now()) {
    markPlan(rootDir, token, "expired", { expiredAt: new Date().toISOString() });
    throw new Error("Confirmation token has expired");
  }
  return plan;
}

function removeSecret(rootDir, token) {
  fs.rmSync(planSecretPath(rootDir, token), { force: true });
}

function readPlanSecrets(rootDir, token, planId) {
  const file = planSecretPath(rootDir, token);
  if (!fs.existsSync(file)) throw new Error("Pending plan secrets are missing");
  const secrets = JSON.parse(fs.readFileSync(file, "utf8"));
  if (secrets.planId !== planId) throw new Error("Pending plan secrets do not match the plan");
  return secrets;
}

export function claimPlan(rootDir, token) {
  const lockFile = planLockPath(rootDir, token);
  let lockFd;
  try {
    lockFd = fs.openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Plan is already being executed");
    throw error;
  }

  try {
    const plan = loadPlan(rootDir, token);
    const secrets = readPlanSecrets(rootDir, token, plan.id);
    if (secrets.operations.length !== plan.operations.length) {
      throw new Error("Pending plan secrets do not match the operation count");
    }
    const executing = {
      ...plan,
      status: "executing",
      claimedAt: new Date().toISOString()
    };
    fs.writeFileSync(planPath(rootDir, token), JSON.stringify(executing, null, 2), { mode: 0o600 });
    removeSecret(rootDir, token);
    appendAudit(rootDir, { action: "plan_claimed", plan: publicPlan(executing) });
    return {
      ...executing,
      operations: secrets.operations
    };
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    fs.rmSync(lockFile, { force: true });
  }
}

export function cleanupExpiredPlans(rootDir, now = new Date()) {
  const dir = planDir(rootDir);
  if (!fs.existsSync(dir)) return { expired: 0, interrupted: 0, removedSecrets: 0 };
  let expired = 0;
  let interrupted = 0;
  let removedSecrets = 0;
  for (const fileName of fs.readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue;
    const token = fileName.slice(0, -5);
    const file = path.join(dir, fileName);
    const plan = JSON.parse(fs.readFileSync(file, "utf8"));
    if (plan.status === "pending" && new Date(plan.expiresAt).getTime() <= now.getTime()) {
      const updated = {
        ...plan,
        status: "expired",
        completedAt: now.toISOString(),
        result: { expiredAt: now.toISOString() }
      };
      fs.writeFileSync(file, JSON.stringify(updated, null, 2), { mode: 0o600 });
      appendAudit(rootDir, { action: "plan_expired", plan: publicPlan(updated), details: updated.result });
      expired += 1;
    }
    if (
      plan.status === "executing" &&
      new Date(plan.claimedAt ?? plan.createdAt).getTime() + EXECUTING_STALE_MS <= now.getTime()
    ) {
      const updated = {
        ...plan,
        status: "interrupted",
        completedAt: now.toISOString(),
        result: {
          interruptedAt: now.toISOString(),
          remediationRequired: true,
          reason: "Plan was claimed for execution but did not reach a terminal state before the stale execution window."
        }
      };
      fs.writeFileSync(file, JSON.stringify(updated, null, 2), { mode: 0o600 });
      appendAudit(rootDir, { action: "plan_interrupted", plan: publicPlan(updated), details: updated.result });
      interrupted += 1;
    }
    if (plan.status !== "pending" || new Date(plan.expiresAt).getTime() <= now.getTime()) {
      if (fs.existsSync(planSecretPath(rootDir, token))) {
        removeSecret(rootDir, token);
        removedSecrets += 1;
      }
    }
  }
  return { expired, interrupted, removedSecrets };
}

export function markPlan(rootDir, token, status, details = {}) {
  const file = planPath(rootDir, token);
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  const updated = {
    ...plan,
    status,
    completedAt: new Date().toISOString(),
    result: redact(details)
  };
  fs.writeFileSync(file, JSON.stringify(updated, null, 2), { mode: 0o600 });
  if (TERMINAL_STATUSES.has(status)) removeSecret(rootDir, token);
  appendAudit(rootDir, { action: `plan_${status}`, plan: publicPlan(updated), details });
  return updated;
}

export function appendAudit(rootDir, event) {
  const file = auditPath(rootDir);
  ensureDir(path.dirname(file));
  fs.appendFileSync(
    file,
    `${JSON.stringify(redact({ timestamp: new Date().toISOString(), ...event }))}\n`,
    { mode: 0o600 }
  );
}
