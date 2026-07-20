import path from "node:path";
import {
  CommandName,
  EufySecurity,
  LogLevel,
  P2PConnectionType,
  UserPasswordType
} from "eufy-security-client";
import { requireEnv } from "../env.mjs";
import { safeError } from "../redact.mjs";
import { toBackendSchedule } from "../schedule.mjs";

const LOCK_COMMANDS = {
  addUser: CommandName.DeviceAddUser,
  deleteUser: CommandName.DeviceDeleteUser,
  updatePasscode: CommandName.DeviceUpdateUserPasscode,
  updateSchedule: CommandName.DeviceUpdateUserSchedule,
  queryAllUsers: CommandName.DeviceQueryAllUserId
};

const DEFAULT_WRITE_ACK_TIMEOUT_MS = 60_000;

function callOrUndefined(object, method) {
  try {
    return typeof object?.[method] === "function" ? object[method]() : undefined;
  } catch {
    return undefined;
  }
}

function isLockDevice(device) {
  const explicit = callOrUndefined(device, "isLock");
  if (explicit === true) return true;
  const name = String(callOrUndefined(device, "getName") ?? "").toLowerCase();
  const model = String(callOrUndefined(device, "getModel") ?? "").toLowerCase();
  return name.includes("lock") || model.includes("lock");
}

function capabilitiesFor(device) {
  const has = (command) => {
    try {
      return typeof device?.hasCommand === "function" ? Boolean(device.hasCommand(command)) : false;
    } catch {
      return false;
    }
  };
  return {
    addUser: has(LOCK_COMMANDS.addUser),
    deleteUser: has(LOCK_COMMANDS.deleteUser),
    updatePasscode: has(LOCK_COMMANDS.updatePasscode),
    updateSchedule: has(LOCK_COMMANDS.updateSchedule),
    queryAllUsers: has(LOCK_COMMANDS.queryAllUsers)
  };
}

function serializeLock(device) {
  const rawDevice = callOrUndefined(device, "getRawDevice") ?? {};
  const serial = String(callOrUndefined(device, "getSerial") ?? rawDevice.device_sn ?? "");
  const capabilities = capabilitiesFor(device);
  return {
    serial,
    name: String(callOrUndefined(device, "getName") ?? rawDevice.device_name ?? serial),
    model: String(callOrUndefined(device, "getModel") ?? rawDevice.device_model ?? ""),
    deviceType: callOrUndefined(device, "getDeviceType") ?? rawDevice.device_type,
    stationSerial: String(callOrUndefined(device, "getStationSerial") ?? rawDevice.station_sn ?? ""),
    capabilities,
    supportsCodeCrud: capabilities.addUser && capabilities.deleteUser && capabilities.updatePasscode,
    lockKinds: {
      wifi: callOrUndefined(device, "isLockWifi") === true,
      wifiNoFinger: callOrUndefined(device, "isLockWifiNoFinger") === true,
      wifiVideo: callOrUndefined(device, "isLockWifiVideo") === true,
      retrofitR10: callOrUndefined(device, "isLockWifiR10") === true,
      retrofitR20: callOrUndefined(device, "isLockWifiR20") === true,
      keypad: callOrUndefined(device, "isLockKeypad") === true,
      bluetoothOnly: callOrUndefined(device, "isLockBle") === true || callOrUndefined(device, "isLockBleNoFinger") === true
    }
  };
}

function buildHouseMap(houses = []) {
  const byDeviceSerial = new Map();
  for (const house of houses) {
    const houseInfo = {
      houseId: house.house_id,
      houseName: house.house_name
    };
    for (const device of house.devices ?? []) {
      if (device.device_sn) byDeviceSerial.set(device.device_sn, houseInfo);
    }
    for (const station of house.stations ?? house.house_stations ?? []) {
      if (station.station_sn) byDeviceSerial.set(station.station_sn, houseInfo);
      for (const device of station.devices ?? []) {
        if (device.device_sn) byDeviceSerial.set(device.device_sn, houseInfo);
      }
    }
  }
  return byDeviceSerial;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeUser(user) {
  return {
    username: user.user_name,
    shortUserId: user.short_user_id,
    userId: user.user_id,
    userType: user.user_type,
    isVisible: user.is_show,
    passcodes: (user.password_list ?? []).map((entry) => ({
      passwordId: entry.password_id,
      passwordType: entry.password_type,
      isPin: isPinPassword(entry),
      label: entry.name,
      isPermanent: Boolean(entry.is_permanent),
      expirationTime: entry.expiration_time,
      plaintextPasscodeAvailable: Boolean(entry.password),
      passcodeMasked: entry.password ? `****${String(entry.password).slice(-2)}` : undefined,
      schedule: parseMaybeJson(entry.schedule)
    }))
  };
}

function normalizePasswordListEntry(entry) {
  return {
    ...entry,
    password_id: entry.password_id ?? entry.passwordId,
    password_type: entry.password_type ?? entry.passwordType,
    password: entry.password ?? ""
  };
}

function mergePasswordListUsers(users, passwordListUsers = []) {
  const byUserAndPassword = new Map();
  const byUser = new Map();
  for (const passwordListUser of passwordListUsers) {
    const shortUserId = passwordListUser.short_user_id ?? passwordListUser.shortUserId;
    for (const entry of passwordListUser.passwordList ?? passwordListUser.password_list ?? []) {
      const normalized = normalizePasswordListEntry(entry);
      if (!shortUserId || !normalized.password_id) continue;
      byUserAndPassword.set(`${shortUserId}:${normalized.password_id}`, normalized);
      if (!byUser.has(shortUserId)) byUser.set(shortUserId, []);
      byUser.get(shortUserId).push(normalized);
    }
  }
  return users.map((user) => ({
    ...user,
    password_list: [
      ...(user.password_list ?? []).map((entry) => {
        const normalized = normalizePasswordListEntry(entry);
        const passwordListEntry = byUserAndPassword.get(`${user.short_user_id}:${normalized.password_id}`);
        return {
          ...normalized,
          ...passwordListEntry,
          password: normalized.password || passwordListEntry?.password || ""
        };
      }),
      ...(byUser.get(user.short_user_id) ?? []).filter(
        (entry) => !(user.password_list ?? []).some((existing) => normalizePasswordListEntry(existing).password_id === entry.password_id)
      )
    ]
  }));
}

function deviceSerial(device) {
  return String(callOrUndefined(device, "getSerial") ?? "");
}

function isMatchingUserEvent(device, username, expectedDeviceSN, expectedUsername) {
  return deviceSerial(device) === expectedDeviceSN && String(username) === String(expectedUsername);
}

function isPinPassword(entry) {
  return entry?.password_type === UserPasswordType.PIN || String(entry?.password_type) === String(UserPasswordType.PIN);
}

function assertExpectedUserIdentity(user, expectedUser = {}, deviceSN, username) {
  if (expectedUser.shortUserId && String(user.short_user_id) !== String(expectedUser.shortUserId)) {
    throw new Error(`User ${username} identity changed on lock ${deviceSN}`);
  }
  if (expectedUser.userId && String(user.user_id) !== String(expectedUser.userId)) {
    throw new Error(`User ${username} identity changed on lock ${deviceSN}`);
  }
}

export class EufyLockBackend {
  constructor({ rootDir = process.cwd(), env = process.env, clientFactory = EufySecurity.initialize } = {}) {
    this.rootDir = rootDir;
    this.env = env;
    this.clientFactory = clientFactory;
    this.client = undefined;
    this.connectPromise = undefined;
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#connect();
    this.client = await this.connectPromise;
    return this.client;
  }

  async #connect() {
    const credentials = requireEnv(this.rootDir, this.env);
    const client = await this.clientFactory({
      username: credentials.username,
      password: credentials.password,
      country: credentials.country,
      language: credentials.language,
      trustedDeviceName: "Eufy Lock Codes MCP",
      persistentDir: path.join(this.rootDir, "data", "eufy-persistent"),
      p2pConnectionSetup: P2PConnectionType.QUICKEST,
      pollingIntervalMinutes: 10,
      eventDurationSeconds: 10,
      acceptInvitations: false,
      logging: {
        level: LogLevel.Off
      }
    });
    await client.connect({ force: false });
    return client;
  }

  async close() {
    if (this.client && typeof this.client.close === "function") this.client.close();
    this.client = undefined;
    this.connectPromise = undefined;
  }

  async #withUserAck({ deviceSN, username, successEvent, action, invoke }) {
    const client = await this.connect();
    const timeoutMs = Number.parseInt(this.env.EUFY_WRITE_ACK_TIMEOUT_MS ?? "", 10) || DEFAULT_WRITE_ACK_TIMEOUT_MS;

    return await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        client.removeListener(successEvent, onSuccess);
        client.removeListener("user error", onUserError);
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const timer = setTimeout(() => {
        settle(
          reject,
          Object.assign(
            new Error(
              `${action} was sent for ${username} on ${deviceSN}, but no Eufy lock acknowledgment arrived within ${timeoutMs}ms`
            ),
            { mayHaveApplied: true }
          )
        );
      }, timeoutMs);
      const onSuccess = (device, eventUsername) => {
        if (!isMatchingUserEvent(device, eventUsername, deviceSN, username)) return;
        settle(resolve, { event: successEvent });
      };
      const onUserError = (device, eventUsername, error) => {
        if (!isMatchingUserEvent(device, eventUsername, deviceSN, username)) return;
        settle(reject, error instanceof Error ? error : new Error(String(error)));
      };

      client.on(successEvent, onSuccess);
      client.on("user error", onUserError);
      Promise.resolve()
        .then(invoke)
        .catch((error) => settle(reject, error));
    });
  }

  async discoverLocks() {
    const client = await this.connect();
    const api = client.getApi();
    const [devices, houseList] = await Promise.all([
      client.getDevices(),
      api.getHouseList().catch(() => [])
    ]);
    const houseDetails = await Promise.all(
      houseList.map(async (house) => {
        const detail = await api.getHouseDetail(house.house_id).catch(() => null);
        return detail ?? house;
      })
    );
    const houses = houseDetails.length > 0 ? houseDetails : houseList;
    const houseBySerial = buildHouseMap(houses);
    return devices
      .filter(isLockDevice)
      .map((device) => {
        const lock = serializeLock(device);
        const house = houseBySerial.get(lock.serial) ?? houseBySerial.get(lock.stationSerial);
        return {
          ...lock,
          eufyHouseName: house?.houseName
        };
      })
      .filter((lock) => lock.serial);
  }

  async getLockUsers(deviceSN) {
    const client = await this.connect();
    const device = await client.getDevice(deviceSN);
    const stationSN = device.getStationSerial();
    const api = client.getApi();
    const [users, passwordListUsers] = await Promise.all([
      api.getUsers(deviceSN, stationSN),
      this.getLockPasswordList(deviceSN, stationSN).catch(() => [])
    ]);
    if (!users) throw new Error(`Eufy returned no user list for lock ${deviceSN}`);
    return mergePasswordListUsers(users, passwordListUsers).map(serializeUser);
  }

  async getLockPasswordList(deviceSN, stationSN) {
    const client = await this.connect();
    const api = client.getApi();
    const effectiveStationSN = stationSN ?? (await client.getDevice(deviceSN)).getStationSerial();
    const response = await api.request({
      method: "get",
      endpoint: `v1/app/device/password/list?device_sn=${deviceSN}&station_sn=${effectiveStationSN}`
    });
    return response.data?.data?.user_password_list ?? [];
  }

  async #lookupUserForWrite(deviceSN, username, expectedUser) {
    const client = await this.connect();
    const device = await client.getDevice(deviceSN);
    const stationSN = device.getStationSerial();
    const api = client.getApi();
    const [users, passwordListUsers] = await Promise.all([
      api.getUsers(deviceSN, stationSN),
      this.getLockPasswordList(deviceSN, stationSN).catch(() => [])
    ]);
    if (!users) throw new Error(`Eufy returned no user list for lock ${deviceSN}`);
    const matches = mergePasswordListUsers(users, passwordListUsers).filter((user) => user.user_name === username);
    if (matches.length === 0) throw new Error(`User ${username} was not found on lock ${deviceSN}`);
    if (matches.length > 1) throw new Error(`User ${username} is ambiguous on lock ${deviceSN}`);
    const user = matches[0];
    assertExpectedUserIdentity(user, expectedUser, deviceSN, username);
    const pin = (user.password_list ?? []).find(isPinPassword);
    const station = await client.getStation(stationSN);
    return {
      client,
      device,
      station,
      username: user.user_name,
      shortUserId: user.short_user_id,
      userId: user.user_id,
      passwordId: pin?.password_id
    };
  }

  async addUser(deviceSN, username, passcode, schedule) {
    const client = await this.connect();
    await this.#withUserAck({
      deviceSN,
      username,
      successEvent: "user added",
      action: "addUser",
      invoke: () => client.addUser(deviceSN, username, passcode, toBackendSchedule(schedule))
    });
  }

  async deleteUser(deviceSN, username, expectedUser) {
    const user = await this.#lookupUserForWrite(deviceSN, username, expectedUser);
    await this.#withUserAck({
      deviceSN,
      username,
      successEvent: "user deleted",
      action: "deleteUser",
      invoke: () => user.station.deleteUser(user.device, user.username, user.shortUserId)
    });
  }

  async updateUserPasscode(deviceSN, username, passcode, expectedUser) {
    const user = await this.#lookupUserForWrite(deviceSN, username, expectedUser);
    if (!user.passwordId) throw new Error(`No PIN passcode entry found for user ${username} on lock ${deviceSN}`);
    await this.#withUserAck({
      deviceSN,
      username,
      successEvent: "user passcode updated",
      action: "updateUserPasscode",
      invoke: () => user.station.updateUserPasscode(user.device, user.username, user.passwordId, passcode)
    });
  }

  async updateUserSchedule(deviceSN, username, schedule, expectedUser) {
    const user = await this.#lookupUserForWrite(deviceSN, username, expectedUser);
    await this.#withUserAck({
      deviceSN,
      username,
      successEvent: "user schedule updated",
      action: "updateUserSchedule",
      invoke: () => user.station.updateUserSchedule(user.device, user.username, user.shortUserId, toBackendSchedule(schedule))
    });
  }
}

export function backendError(error) {
  return safeError(error);
}
