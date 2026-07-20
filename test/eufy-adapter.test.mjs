import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { UserPasswordType } from "eufy-security-client";
import { EufyLockBackend } from "../src/backend/eufy-adapter.mjs";
import { makeTempRoot } from "./helpers.mjs";

test("updateUserPasscode resolves password_id from password-list endpoint", async () => {
  const rootDir = makeTempRoot();
  const calls = [];
  const device = {
    getSerial: () => "LOCK1",
    getStationSerial: () => "STATION1",
    hasCommand: () => true
  };
  const api = {
    async getUsers() {
      return [
        {
          user_name: "Guest",
          short_user_id: "0001",
          password_list: []
        }
      ];
    },
    async request() {
      return {
        data: {
          data: {
            user_password_list: [
              {
                short_user_id: "0001",
                passwordList: [
                  {
                    password_id: "PIN1",
                    password_type: UserPasswordType.PIN
                  }
                ]
              }
            ]
          }
        }
      };
    }
  };
  const client = new EventEmitter();
  client.connect = async () => {};
  client.close = () => {};
  client.getApi = () => api;
  client.getDevice = async () => device;
  client.getStation = async () => ({
    updateUserPasscode(stationDevice, username, passwordId, passcode) {
      calls.push({ stationDevice, username, passwordId, passcode });
      queueMicrotask(() => client.emit("user passcode updated", stationDevice, username));
    }
  });

  const backend = new EufyLockBackend({
    rootDir,
    env: {
      eufy_email: "test@example.com",
      eufy_pass: "secret"
    },
    clientFactory: async () => client
  });

  await backend.updateUserPasscode("LOCK1", "Guest", "123456");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].passwordId, "PIN1");
  assert.equal(calls[0].passcode, "123456");
});
