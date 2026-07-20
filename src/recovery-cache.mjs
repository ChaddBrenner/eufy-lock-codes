import fs from "node:fs";
import path from "node:path";
import { maskPasscode } from "./redact.mjs";

function backupDir(rootDir) {
  return path.join(rootDir, "data", "backups");
}

function latestMergedInventoryPath(rootDir) {
  const dir = backupDir(rootDir);
  if (!fs.existsSync(dir)) return undefined;
  const latest = fs
    .readdirSync(dir)
    .filter((file) => /^merged-lock-code-inventory-.*\.json$/.test(file))
    .sort()
    .pop();
  return latest ? path.join(dir, latest) : undefined;
}

export function loadRecoveryCache(rootDir) {
  const file = latestMergedInventoryPath(rootDir);
  if (!file) return { path: undefined, capturedAt: undefined, byDeviceSN: new Map() };
  const inventory = JSON.parse(fs.readFileSync(file, "utf8"));
  const byDeviceSN = new Map();
  for (const lock of inventory.results ?? []) {
    byDeviceSN.set(
      lock.lockSerial,
      (lock.codes ?? []).map((code) => ({
        ...code,
        lockSerial: lock.lockSerial
      }))
    );
  }
  return {
    path: file,
    capturedAt: inventory.capturedAt,
    byDeviceSN
  };
}

function matchRecoveryEntry(entries, user, passcode) {
  return entries.find(
    (entry) =>
      String(entry.shortUserId ?? "") === String(user.shortUserId ?? "") &&
      String(entry.passwordId ?? "") === String(passcode.passwordId ?? "")
  );
}

function sourceLabel(entry) {
  if (entry.passcodeSource === "p2p-query-pw") return "local-p2p-recovery";
  if (entry.passcodeSource === "cloud-password-list") return "eufy-cloud";
  return "local-recovery-cache";
}

export function mergeRecoveryCacheIntoUsers(rootDir, deviceSN, users) {
  const recovery = loadRecoveryCache(rootDir);
  const entries = recovery.byDeviceSN.get(deviceSN) ?? [];
  if (entries.length === 0) return users;

  return users.map((user) => ({
    ...user,
    passcodes: (user.passcodes ?? []).map((passcode) => {
      const entry = matchRecoveryEntry(entries, user, passcode);
      if (!entry) return passcode;
      const known = entry.status === "known" && entry.passcode;
      return {
        ...passcode,
        localRecoveryAvailable: Boolean(known),
        localRecoveryStatus: known ? "known" : entry.status,
        localRecoveryCapturedAt: recovery.capturedAt,
        passcodeKnown: Boolean(passcode.passcodeKnown || passcode.plaintextPasscodeAvailable || known),
        plaintextStatus:
          passcode.plaintextStatus ??
          (known ? "known-local-recovery-cache" : passcode.plaintextPasscodeAvailable ? "known-eufy-cloud" : "unknown"),
        passcodeSources: [
          ...new Set([
            ...(passcode.passcodeSources ?? (passcode.plaintextPasscodeAvailable ? ["eufy-cloud"] : [])),
            ...(known ? [sourceLabel(entry)] : [])
          ])
        ],
        passcodeMasked: passcode.passcodeMasked ?? (known ? maskPasscode(entry.passcode) : undefined)
      };
    })
  }));
}
