const TAGS = {
  a1: "recordType",
  a2: "permission",
  a3: "shortUserId",
  a4: "startDate",
  a5: "endDate",
  a6: "week",
  a7: "startTime",
  a8: "endTime",
  a9: "username",
  aa: "passwordId",
  ab: "unknownAb",
  ac: "unknownAc"
};

const WEEK_DAYS = [
  ["sunday", 1],
  ["monday", 2],
  ["tuesday", 4],
  ["wednesday", 8],
  ["thursday", 16],
  ["friday", 32],
  ["saturday", 64]
];

function tagName(tag) {
  return TAGS[tag] ?? `tag_${tag}`;
}

function hex(value) {
  return value.toString("hex").toUpperCase();
}

function readUInt(value) {
  if (value.length === 0) return undefined;
  return value.readUIntBE(0, value.length);
}

function decodeDate(value) {
  const raw = hex(value);
  if (raw === "00000000") return { raw, value: null, kind: "unset" };
  if (raw === "FFFFFFFF") return { raw, value: null, kind: "forever" };
  if (value.length !== 4) return { raw, value: null, kind: "unknown" };
  const year = (value[1] << 8) + value[0];
  const month = value[2];
  const day = value[3];
  return {
    raw,
    value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    kind: "date"
  };
}

function decodeTime(value) {
  const raw = hex(value);
  if (raw === "0000") return { raw, value: "00:00", kind: "time" };
  if (raw === "FFFF") return { raw, value: null, kind: "all-day-end" };
  if (value.length !== 2) return { raw, value: null, kind: "unknown" };
  return {
    raw,
    value: `${String(value[0]).padStart(2, "0")}:${String(value[1]).padStart(2, "0")}`,
    kind: "time"
  };
}

function decodeWeek(value) {
  const raw = hex(value);
  if (value.length !== 1) return { raw, value: [], kind: "unknown" };
  const mask = value[0];
  return {
    raw,
    mask,
    value: WEEK_DAYS.filter(([, bit]) => (mask & bit) !== 0).map(([day]) => day),
    kind: mask === 0xff || mask === 0x7f ? "all-days" : "partial"
  };
}

function normalizeField(tag, value) {
  switch (tag) {
    case "a1":
    case "a2":
    case "ab":
    case "ac":
      return readUInt(value);
    case "a3":
    case "aa":
      return hex(value).padStart(4, "0");
    case "a4":
    case "a5":
      return decodeDate(value);
    case "a6":
      return decodeWeek(value);
    case "a7":
    case "a8":
      return decodeTime(value);
    case "a9":
      return value.toString("utf8");
    default:
      return hex(value);
  }
}

function simplifyRecord(fields, rawFields) {
  return {
    shortUserId: fields.shortUserId,
    passwordId: fields.passwordId,
    username: fields.username,
    permission: fields.permission,
    recordType: fields.recordType,
    schedule: {
      startDate: fields.startDate,
      endDate: fields.endDate,
      week: fields.week,
      startTime: fields.startTime,
      endTime: fields.endTime
    },
    flags: {
      unknownAb: fields.unknownAb,
      unknownAc: fields.unknownAc
    },
    rawFields
  };
}

export function parseSmartLockQueryAllUsersDecodedHex(decodedHex) {
  const data = Buffer.from(decodedHex, "hex");
  if (data.length === 0) return { returnCode: undefined, records: [], trailingHex: "" };
  const returnCode = data.readUInt8(0);
  const records = [];
  let offset = 1;

  while (offset < data.length) {
    const fields = {};
    const rawFields = {};

    while (offset < data.length) {
      const tagByte = data.readUInt8(offset);
      const tag = tagByte.toString(16).padStart(2, "0");
      if (tag === "a1" && Object.keys(fields).length > 0) break;
      if (offset + 1 >= data.length) break;
      const length = data.readUInt8(offset + 1);
      const start = offset + 2;
      const end = start + length;
      if (end > data.length) break;
      const value = data.subarray(start, end);
      rawFields[tag] = hex(value);
      fields[tagName(tag)] = normalizeField(tag, value);
      offset = end;
    }

    if (Object.keys(fields).length === 0) break;
    records.push(simplifyRecord(fields, rawFields));
  }

  return {
    returnCode,
    records,
    trailingHex: offset < data.length ? hex(data.subarray(offset)) : ""
  };
}

export function parseSmartLockQueryPasswordDecodedHex(decodedHex) {
  const data = Buffer.from(decodedHex, "hex");
  if (data.length === 0) return { returnCode: undefined, passcode: undefined, fields: {}, trailingHex: "" };
  const returnCode = data.readUInt8(0);
  const fields = {};
  let offset = 1;

  while (offset < data.length) {
    if (offset + 1 >= data.length) break;
    const tag = data.readUInt8(offset).toString(16).padStart(2, "0");
    const length = data.readUInt8(offset + 1);
    const start = offset + 2;
    const end = start + length;
    if (end > data.length) break;
    const value = data.subarray(start, end);
    fields[tag] = {
      raw: hex(value),
      text: value.toString("utf8")
    };
    offset = end;
  }

  return {
    returnCode,
    passcode: fields.a1?.text,
    fields,
    trailingHex: offset < data.length ? hex(data.subarray(offset)) : ""
  };
}
