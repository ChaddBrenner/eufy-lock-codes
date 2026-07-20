import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { mergeRecoveryCacheIntoUsers } from "../src/recovery-cache.mjs";
import { makeTempRoot } from "./helpers.mjs";

function writeMergedInventory(root, body) {
  const dir = path.join(root, "data", "backups");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "merged-lock-code-inventory-2026-07-06T00-00-00-000Z.json"),
    JSON.stringify(body, null, 2)
  );
}

test("mergeRecoveryCacheIntoUsers adds masked P2P recovery status", () => {
  const root = makeTempRoot();
  writeMergedInventory(root, {
    capturedAt: "2026-07-06T00:00:00.000Z",
    results: [
      {
        lockSerial: "LOCK1",
        codes: [
          {
            userName: "Old Tenant",
            shortUserId: "0001",
            passwordId: "1001",
            status: "known",
            passcode: "11112222",
            passcodeSource: "p2p-query-pw"
          }
        ]
      }
    ]
  });

  const users = [
    {
      username: "Old Tenant",
      shortUserId: "0001",
      passcodes: [{ passwordId: "1001", plaintextPasscodeAvailable: false }]
    }
  ];

  const result = mergeRecoveryCacheIntoUsers(root, "LOCK1", users);
  const passcode = result[0].passcodes[0];

  assert.equal(passcode.localRecoveryAvailable, true);
  assert.equal(passcode.localRecoveryStatus, "known");
  assert.equal(passcode.passcodeKnown, true);
  assert.equal(passcode.plaintextStatus, "known-local-recovery-cache");
  assert.deepEqual(passcode.passcodeSources, ["local-p2p-recovery"]);
  assert.equal(passcode.passcodeMasked, "******22");
  assert.equal(JSON.stringify(result).includes("11112222"), false);
});

test("mergeRecoveryCacheIntoUsers preserves unknown recovery reasons", () => {
  const root = makeTempRoot();
  writeMergedInventory(root, {
    capturedAt: "2026-07-06T00:00:00.000Z",
    results: [
      {
        lockSerial: "LOCK1",
        codes: [
          {
            userName: "Old Tenant",
            shortUserId: "0001",
            passwordId: "1001",
            status: "unknown-lock-return-code-1"
          }
        ]
      }
    ]
  });

  const users = [
    {
      username: "Old Tenant",
      shortUserId: "0001",
      passcodes: [{ passwordId: "1001", plaintextPasscodeAvailable: false }]
    }
  ];

  const result = mergeRecoveryCacheIntoUsers(root, "LOCK1", users);
  const passcode = result[0].passcodes[0];

  assert.equal(passcode.localRecoveryAvailable, false);
  assert.equal(passcode.localRecoveryStatus, "unknown-lock-return-code-1");
  assert.equal(passcode.passcodeKnown, false);
  assert.equal(passcode.plaintextStatus, "unknown");
});
