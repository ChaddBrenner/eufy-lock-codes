#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createToolHandlers } from "../src/tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eufy-lock-codes-demo-"));
process.on("exit", () => fs.rmSync(tempRoot, { recursive: true, force: true }));

class DemoBackend {
  constructor() {
    this.calls = [];
    this.users = [
      {
        username: "Property Manager",
        shortUserId: "0000",
        passcodes: [{ passwordId: "0000", plaintextPasscodeAvailable: false, passcodeMasked: "****89" }]
      },
      {
        username: "Maintenance",
        shortUserId: "0001",
        passcodes: [{ passwordId: "0001", plaintextPasscodeAvailable: false }]
      }
    ];
  }

  async discoverLocks() {
    return [
      {
        serial: "T8500EXAMPLE",
        name: "Front Door",
        stationSerial: "T8500EXAMPLE",
        model: "Smart Lock",
        capabilities: {
          addUser: true,
          deleteUser: true,
          updatePasscode: true,
          updateSchedule: true,
          queryAllUsers: true
        }
      }
    ];
  }

  async getLockUsers() {
    return this.users;
  }

  async addUser(deviceSN, username, passcode, schedule) {
    this.calls.push({ method: "addUser", deviceSN, username, passcode, schedule });
  }

  async deleteUser(deviceSN, username) {
    this.calls.push({ method: "deleteUser", deviceSN, username });
  }

  async updateUserPasscode(deviceSN, username, passcode) {
    this.calls.push({ method: "updateUserPasscode", deviceSN, username, passcode });
  }

  async updateUserSchedule(deviceSN, username, schedule) {
    this.calls.push({ method: "updateUserSchedule", deviceSN, username, schedule });
  }
}

const backend = new DemoBackend();
const tools = createToolHandlers({
  backend,
  rootDir: tempRoot,
  configPath: path.join(repoRoot, "config", "properties.example.yaml")
});

const list = await tools.list_lock_codes({ property: "sample-property", lockAlias: "front" });
const plan = await tools.plan_create_code({
  property: "sample-property",
  lockAlias: "front",
  username: "Vendor",
  passcode: "246813",
  schedule: {
    startDateTime: "2030-01-01T14:00:00.000Z",
    endDateTime: "2030-01-01T18:00:00.000Z"
  },
  reason: "demo maintenance window"
});

console.log(
  JSON.stringify(
    {
      locksListed: list.count,
      dryRunStatus: plan.status,
      operationCount: plan.operationCount,
      passcodeReturnedInPublicPlan: JSON.stringify(plan).includes("246813"),
      backendWriteCallsDuringDryRun: backend.calls.length,
      note: "Demo uses an in-memory backend and temp runtime state. It proves dry-run behavior without Eufy credentials."
    },
    null,
    2
  )
);
