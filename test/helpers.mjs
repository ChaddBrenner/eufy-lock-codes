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
    },
    fail = {}
  } = {}) {
    this.locks = locks;
    this.users = users;
    this.calls = [];
    this.fail = fail;
  }

  async discoverLocks() {
    return this.locks;
  }

  async getLockUsers(deviceSN) {
    if (!this.users[deviceSN]) throw new Error(`No users for ${deviceSN}`);
    return this.users[deviceSN];
  }

  async addUser(deviceSN, username, passcode, schedule) {
    if (this.fail.addUser) throw new Error(this.fail.addUser);
    this.calls.push({ method: "addUser", deviceSN, username, passcode, schedule });
    const users = this.users[deviceSN] ?? [];
    if (users.some((user) => user.username === username)) throw new Error(`User ${username} already exists`);
    users.push({
      username,
      shortUserId: String(users.length + 1).padStart(4, "0"),
      passcodes: [
        {
          passwordId: String(users.length + 1).padStart(4, "0"),
          isPin: true,
          plaintextPasscodeAvailable: false,
          schedule
        }
      ]
    });
    this.users[deviceSN] = users;
  }

  #assertExpectedUser(user, expectedUser = {}) {
    if (expectedUser.shortUserId && String(user.shortUserId) !== String(expectedUser.shortUserId)) {
      throw new Error(`User ${user.username} identity changed`);
    }
    if (expectedUser.userId && String(user.userId) !== String(expectedUser.userId)) {
      throw new Error(`User ${user.username} identity changed`);
    }
  }

  async deleteUser(deviceSN, username, expectedUser) {
    if (this.fail.deleteUser) throw new Error(this.fail.deleteUser);
    const users = this.users[deviceSN] ?? [];
    const index = users.findIndex((user) => user.username === username);
    if (index === -1) throw new Error(`User ${username} was not found`);
    this.#assertExpectedUser(users[index], expectedUser);
    this.calls.push({ method: "deleteUser", deviceSN, username });
    users.splice(index, 1);
  }

  async updateUserPasscode(deviceSN, username, passcode, expectedUser) {
    if (this.fail.updateUserPasscode) throw new Error(this.fail.updateUserPasscode);
    const user = (this.users[deviceSN] ?? []).find((candidate) => candidate.username === username);
    if (!user) throw new Error(`User ${username} was not found`);
    this.#assertExpectedUser(user, expectedUser);
    this.calls.push({ method: "updateUserPasscode", deviceSN, username, passcode });
    const passcodeEntry = user.passcodes?.[0] ?? {};
    user.passcodes = [{ ...passcodeEntry, plaintextPasscodeAvailable: false }];
  }

  async updateUserSchedule(deviceSN, username, schedule, expectedUser) {
    if (this.fail.updateUserSchedule) throw new Error(this.fail.updateUserSchedule);
    const user = (this.users[deviceSN] ?? []).find((candidate) => candidate.username === username);
    if (!user) throw new Error(`User ${username} was not found`);
    this.#assertExpectedUser(user, expectedUser);
    this.calls.push({ method: "updateUserSchedule", deviceSN, username, schedule });
    const passcodeEntry = user.passcodes?.[0] ?? {};
    user.passcodes = [{ ...passcodeEntry, schedule }];
  }
}
