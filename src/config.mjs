import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const DEFAULT_CONFIG_PATH = "config/properties.local.yaml";
const DEFAULT_POLICY = {
  minLength: 4,
  maxLength: 8,
  requireNumeric: true
};

function arrayFromMaybe(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeLock(lock) {
  if (!lock || typeof lock !== "object") throw new Error("Each configured lock must be an object");
  const serial = String(lock.serial ?? lock.deviceSN ?? lock.deviceSn ?? "").trim();
  if (!serial) throw new Error("Each configured lock must include serial");
  return {
    serial,
    name: lock.name ? String(lock.name) : serial,
    aliases: arrayFromMaybe(lock.aliases ?? lock.alias).map((alias) => String(alias).toLowerCase())
  };
}

function normalizeProperty(alias, property) {
  if (!property || typeof property !== "object") {
    throw new Error(`Property ${alias} must be an object`);
  }
  const locks = arrayFromMaybe(property.locks).map(normalizeLock);
  return {
    alias: String(alias).toLowerCase(),
    name: property.name ? String(property.name) : String(alias),
    codePolicy: {
      ...DEFAULT_POLICY,
      ...(property.codePolicy ?? property.policy ?? {})
    },
    locks
  };
}

export function normalizePropertyConfig(raw) {
  const properties = raw?.properties ?? {};
  if (Array.isArray(properties)) {
    return {
      properties: properties.map((property) => normalizeProperty(property.alias ?? property.name, property))
    };
  }
  if (properties && typeof properties === "object") {
    return {
      properties: Object.entries(properties).map(([alias, property]) => normalizeProperty(alias, property))
    };
  }
  throw new Error("properties config must be an object or array");
}

export function loadPropertyConfig(rootDir = process.cwd(), configPath = DEFAULT_CONFIG_PATH) {
  const absolutePath = path.isAbsolute(configPath) ? configPath : path.join(rootDir, configPath);
  if (!fs.existsSync(absolutePath)) {
    return { path: absolutePath, properties: [] };
  }
  const rawText = fs.readFileSync(absolutePath, "utf8");
  const raw = rawText.trim() ? yaml.load(rawText) : {};
  return { path: absolutePath, ...normalizePropertyConfig(raw ?? {}) };
}

export function listConfiguredLocks(config) {
  return config.properties.flatMap((property) =>
    property.locks.map((lock) => ({
      propertyAlias: property.alias,
      propertyName: property.name,
      codePolicy: property.codePolicy,
      lockSerial: lock.serial,
      lockName: lock.name,
      lockAliases: lock.aliases
    }))
  );
}

export function resolveTargets(input, config, discoveredLocks = []) {
  const discoveredBySerial = new Map(discoveredLocks.map((lock) => [lock.serial, lock]));
  const configuredLocks = listConfiguredLocks(config);
  const requestedSerials = arrayFromMaybe(input.lockSerials ?? input.lockSerial).filter(Boolean).map(String);
  let targets = [];

  if (input.property) {
    const propertyAlias = String(input.property).toLowerCase();
    const property = config.properties.find(
      (candidate) => candidate.alias === propertyAlias || candidate.name.toLowerCase() === propertyAlias
    );
    if (!property) throw new Error(`Unknown property: ${input.property}`);
    targets = property.locks.map((lock) => ({
      propertyAlias: property.alias,
      propertyName: property.name,
      codePolicy: property.codePolicy,
      lockSerial: lock.serial,
      lockName: lock.name,
      lockAliases: lock.aliases
    }));
    if (input.lockAlias) {
      const lockAlias = String(input.lockAlias).toLowerCase();
      targets = targets.filter(
        (target) =>
          target.lockSerial.toLowerCase() === lockAlias ||
          target.lockName.toLowerCase() === lockAlias ||
          target.lockAliases.includes(lockAlias)
      );
      if (targets.length === 0) throw new Error(`Unknown lock alias for ${input.property}: ${input.lockAlias}`);
    }
  } else if (requestedSerials.length > 0) {
    targets = requestedSerials.map((serial) => {
      const configured = configuredLocks.find((lock) => lock.lockSerial === serial);
      return (
        configured ?? {
          propertyAlias: undefined,
          propertyName: undefined,
          codePolicy: DEFAULT_POLICY,
          lockSerial: serial,
          lockName: discoveredBySerial.get(serial)?.name ?? serial,
          lockAliases: []
        }
      );
    });
  } else if (input.allConfigured) {
    targets = configuredLocks;
  } else {
    throw new Error("Specify property, lockSerial, lockSerials, or allConfigured");
  }

  const seen = new Set();
  return targets.map((target) => {
    if (seen.has(target.lockSerial)) throw new Error(`Duplicate target lock serial: ${target.lockSerial}`);
    seen.add(target.lockSerial);
    const discovered = discoveredBySerial.get(target.lockSerial);
    return {
      ...target,
      lockName: target.lockName ?? discovered?.name ?? target.lockSerial,
      discovered
    };
  });
}
