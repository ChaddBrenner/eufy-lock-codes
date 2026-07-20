import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publicOperation } from "./passcodes.mjs";
import { redact } from "./redact.mjs";

const PLAN_TTL_MS = 15 * 60 * 1000;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function planDir(rootDir) {
  return path.join(rootDir, "data", "plans");
}

function auditPath(rootDir) {
  return path.join(rootDir, "data", "audit", "lock-code-audit.jsonl");
}

function planPath(rootDir, token) {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) throw new Error("Invalid confirmation token format");
  return path.join(planDir(rootDir), `${token}.json`);
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
  const plan = {
    id: crypto.randomUUID(),
    token,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    ...planInput
  };
  ensureDir(planDir(rootDir));
  fs.writeFileSync(planPath(rootDir, token), JSON.stringify(plan, null, 2), { mode: 0o600 });
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
