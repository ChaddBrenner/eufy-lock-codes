#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EufyLockBackend } from "../src/backend/eufy-adapter.mjs";
import { createToolHandlers } from "../src/tools.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = new EufyLockBackend({ rootDir });
const tools = createToolHandlers({ backend, rootDir });

try {
  const health = await tools.health_check();
  console.log(JSON.stringify(health, null, 2));
  if (health.credentials.present) {
    const locks = await tools.discover_locks();
    console.log(JSON.stringify(locks, null, 2));
  }
} finally {
  await backend.close();
  // eufy-security-client may leave background timers open after read-only discovery.
  process.exit(0);
}
