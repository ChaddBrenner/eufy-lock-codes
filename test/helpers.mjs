import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eufy-lock-codes-test-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config", "properties.local.yaml"),
    [
      "properties:",
      "  test-house:",
      "    name: Test House",
      "    codePolicy:",
      "      minLength: 4",
      "      maxLength: 8",
      "      requireNumeric: true",
      "    locks:",
      "      - serial: LOCK1",
      "        name: Front Door",
      "        aliases: [front]",
      ""
    ].join("\n")
  );
  return root;
}

export class MockBackend {
  constructor({
    locks = [
      {
        serial: "LOCK1",
        name: "Front Door",
        stationSerial: "STATION1",
        model: "Smart Lock",
        capabilities: {
          addUser: true,
          deleteUser: true,
          updatePasscode: true,
          updateSchedule: true,
          queryAllUsers: true
        }
      }
    ],
    users = {
      LOCK1: [
        {
          username: "Old Tenant",
          shortUserId: "0001",
          passcodes: [
            {
              passwordId: "1001",
              isPin: true,
              plaintextPasscodeAvailable: false
            }
          ]
        }
      ]
    }
  } = {}) {
    this.locks = locks;
    this.users = users;
    this.calls = [];
  }

  async discoverLocks() {
    return this.locks;
  }

  async getLockUsers(deviceSN) {
    if (!this.users[deviceSN]) throw new Error(`No users for ${deviceSN}`);
    return this.users[deviceSN];
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
