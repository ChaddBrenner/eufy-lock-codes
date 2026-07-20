import fs from "node:fs";
import path from "node:path";
import { maskPasscode } from "./redact.mjs";

const ESCROW_RELATIVE_PATH = path.join("data", "lock-code-escrow.local.json");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function escrowPath(rootDir) {
  return path.join(rootDir, ESCROW_RELATIVE_PATH);
}

function emptyEscrow() {
  return {
    version: 1,
    updatedAt: null,
    note:
      "Local plaintext escrow for passcodes created or updated by the local Eufy MCP server. data/ is git-ignored; keep this file private.",
    entries: []
  };
}

export function loadEscrow(rootDir) {
  const file = escrowPath(rootDir);
  if (!fs.existsSync(file)) return emptyEscrow();
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    ...emptyEscrow(),
    ...parsed,
    entries: Array.isArray(parsed.entries) ? parsed.entries : []
  };
}

function saveEscrow(rootDir, escrow) {
  const file = escrowPath(rootDir);
  const updated = {
    ...escrow,
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [...escrow.entries].sort((left, right) =>
      `${left.deviceSN}:${left.username}:${left.passwordId ?? ""}`.localeCompare(
        `${right.deviceSN}:${right.username}:${right.passwordId ?? ""}`
      )
    )
  };
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(updated, null, 2), { mode: 0o600 });
  return updated;
}

function normalizeUsername(username) {
  return String(username ?? "").trim();
}

function sameEntry(left, right) {
  if (left.deviceSN !== right.deviceSN) return false;
  if (normalizeUsername(left.username) !== normalizeUsername(right.username)) return false;
  if (left.passwordId && right.passwordId) return String(left.passwordId) === String(right.passwordId);
  return true;
}

function operationEntry(operation, planId) {
  return {
    deviceSN: operation.deviceSN,
    propertyAlias: operation.propertyAlias,
    propertyName: operation.propertyName,
    lockName: operation.lockName,
    username: normalizeUsername(operation.username),
    passwordId: operation.passwordId,
    passcode: operation.passcode,
    schedule: operation.schedule,
    planId,
    lastOperation: operation.type,
    updatedAt: new Date().toISOString()
  };
}

export function upsertEscrowPasscode(rootDir, operation, { planId } = {}) {
  if (operation.passcode === undefined) return { action: "skipped", reason: "no-passcode" };
  const escrow = loadEscrow(rootDir);
  const entry = operationEntry(operation, planId);
  const existingIndex = escrow.entries.findIndex((candidate) => sameEntry(candidate, entry));
  if (existingIndex >= 0) {
    escrow.entries[existingIndex] = {
      ...escrow.entries[existingIndex],
      ...entry
    };
  } else {
    escrow.entries.push(entry);
  }
  saveEscrow(rootDir, escrow);
  return { action: existingIndex >= 0 ? "updated" : "stored" };
}

export function updateEscrowSchedule(rootDir, operation, { planId } = {}) {
  if (operation.schedule === undefined) return { action: "skipped", reason: "no-schedule" };
  const escrow = loadEscrow(rootDir);
  const matcher = {
    deviceSN: operation.deviceSN,
    username: normalizeUsername(operation.username),
    passwordId: operation.passwordId
  };
  const existingIndex = escrow.entries.findIndex((candidate) => sameEntry(candidate, matcher));
  if (existingIndex < 0) return { action: "skipped", reason: "no-matching-escrow-entry" };
  escrow.entries[existingIndex] = {
    ...escrow.entries[existingIndex],
    schedule: operation.schedule,
    planId,
    lastOperation: operation.type,
    updatedAt: new Date().toISOString()
  };
  saveEscrow(rootDir, escrow);
  return { action: "updated" };
}

export function removeEscrowEntry(rootDir, operation, { planId } = {}) {
  const escrow = loadEscrow(rootDir);
  const matcher = {
    deviceSN: operation.deviceSN,
    username: normalizeUsername(operation.username),
    passwordId: operation.passwordId
  };
  const before = escrow.entries.length;
  escrow.entries = escrow.entries.filter((candidate) => !sameEntry(candidate, matcher));
  if (escrow.entries.length === before) return { action: "skipped", reason: "no-matching-escrow-entry" };
  saveEscrow(rootDir, {
    ...escrow,
    lastDelete: {
      deviceSN: operation.deviceSN,
      username: operation.username,
      planId,
      deletedAt: new Date().toISOString()
    }
  });
  return { action: "removed", removed: before - escrow.entries.length };
}

function entriesForDevice(escrow, deviceSN) {
  return escrow.entries.filter((entry) => entry.deviceSN === deviceSN);
}

function matchEscrowEntry(entries, user, passcode, userPasscodeCount) {
  const username = normalizeUsername(user.username);
  const userEntries = entries.filter((entry) => normalizeUsername(entry.username) === username);
  if (userEntries.length === 0) return undefined;
  const byPasswordId = userEntries.find(
    (entry) => entry.passwordId && passcode.passwordId && String(entry.passwordId) === String(passcode.passwordId)
  );
  if (byPasswordId) return byPasswordId;
  if (userEntries.length === 1 && userPasscodeCount === 1) return userEntries[0];
  return undefined;
}

function publicEscrowPasscode(entry, status = "known-local-escrow") {
  return {
    passwordId: entry.passwordId,
    isPin: true,
    label: entry.label,
    schedule: entry.schedule,
    plaintextPasscodeAvailable: false,
    localEscrowAvailable: true,
    passcodeKnown: true,
    plaintextStatus: status,
    passcodeSources: ["local-escrow"],
    passcodeMasked: maskPasscode(entry.passcode)
  };
}

function annotateWithoutEscrow(passcode) {
  return {
    ...passcode,
    localEscrowAvailable: false,
    passcodeKnown: Boolean(passcode.passcodeKnown || passcode.plaintextPasscodeAvailable),
    plaintextStatus:
      passcode.plaintextStatus ?? (passcode.plaintextPasscodeAvailable ? "known-eufy-cloud" : "unknown"),
    passcodeSources: passcode.passcodeSources ?? (passcode.plaintextPasscodeAvailable ? ["eufy-cloud"] : [])
  };
}

export function mergeEscrowIntoUsers(rootDir, deviceSN, users) {
  const escrow = loadEscrow(rootDir);
  const deviceEntries = entriesForDevice(escrow, deviceSN);

  const matchedEntryIndexes = new Set();
  const mergedUsers = users.map((user) => {
    const passcodes = user.passcodes ?? [];
    return {
      ...user,
      passcodes: passcodes.map((passcode) => {
        const entry = matchEscrowEntry(deviceEntries, user, passcode, passcodes.length);
        if (!entry) {
          return annotateWithoutEscrow(passcode);
        }
        matchedEntryIndexes.add(deviceEntries.indexOf(entry));
        return {
          ...passcode,
          localEscrowAvailable: true,
          passcodeKnown: true,
          plaintextStatus: "known-local-escrow",
          passcodeSources: [
            ...new Set([
              ...(passcode.passcodeSources ?? (passcode.plaintextPasscodeAvailable ? ["eufy-cloud"] : [])),
              "local-escrow"
            ])
          ],
          passcodeMasked: passcode.passcodeMasked ?? maskPasscode(entry.passcode),
          localEscrowUpdatedAt: entry.updatedAt
        };
      })
    };
  });

  const existingUsernames = new Set(users.map((user) => normalizeUsername(user.username)));
  for (const [index, entry] of deviceEntries.entries()) {
    if (matchedEntryIndexes.has(index)) continue;
    if (existingUsernames.has(normalizeUsername(entry.username))) continue;
    mergedUsers.push({
      username: entry.username,
      localEscrowOnly: true,
      passcodes: [publicEscrowPasscode(entry, "known-local-escrow-not-seen-in-eufy")]
    });
  }

  return mergedUsers;
}
