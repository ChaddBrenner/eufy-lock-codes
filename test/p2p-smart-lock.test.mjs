import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSmartLockQueryAllUsersDecodedHex,
  parseSmartLockQueryPasswordDecodedHex
} from "../src/p2p-smart-lock.mjs";

test("parseSmartLockQueryPasswordDecodedHex extracts TLV passcode", () => {
  const parsed = parseSmartLockQueryPasswordDecodedHex("00a10431323334");

  assert.equal(parsed.returnCode, 0);
  assert.equal(parsed.passcode, "1234");
  assert.equal(parsed.trailingHex, "");
});

test("parseSmartLockQueryAllUsersDecodedHex extracts user and schedule fields", () => {
  const parsed = parseSmartLockQueryAllUsersDecodedHex(
    "00a10102a20104a3020001a40400000000a504ffffffffa6017fa7020000a802ffffa90454657374aa020001ab0100ac0101"
  );

  assert.equal(parsed.returnCode, 0);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].username, "Test");
  assert.equal(parsed.records[0].shortUserId, "0001");
  assert.equal(parsed.records[0].passwordId, "0001");
  assert.equal(parsed.records[0].schedule.week.kind, "all-days");
});
