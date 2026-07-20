#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EufyLockBackend } from "../src/backend/eufy-adapter.mjs";
import { createToolHandlers } from "../src/tools.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = new EufyLockBackend({ rootDir });
const handlers = createToolHandlers({ backend, rootDir });

const server = new McpServer({
  name: "eufy-lock-codes",
  version: "0.1.0"
});

function response(data) {
  return {
    structuredContent: data,
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

const targetSchema = {
  property: z.string().optional().describe("Configured property alias or display name."),
  lockAlias: z.string().optional().describe("Optional lock alias/name within a property."),
  lockSerial: z.string().optional().describe("A single Eufy lock serial number."),
  lockSerials: z.array(z.string()).optional().describe("Explicit Eufy lock serial numbers.")
};

const scheduleSchema = z
  .object({
    startDateTime: z.string().optional(),
    endDateTime: z.string().optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    week: z
      .union([
        z.array(z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])),
        z.object({
          monday: z.boolean().optional(),
          tuesday: z.boolean().optional(),
          wednesday: z.boolean().optional(),
          thursday: z.boolean().optional(),
          friday: z.boolean().optional(),
          saturday: z.boolean().optional(),
          sunday: z.boolean().optional()
        })
      ])
      .optional(),
    weekdays: z.array(z.string()).optional()
  })
  .optional()
  .describe("Optional access schedule. Omit for unrestricted access until changed or deleted.");

server.registerTool(
  "discover_locks",
  {
    title: "Discover Eufy Locks",
    description: "Authenticate with Eufy and list discovered smart locks with capability flags.",
    inputSchema: {}
  },
  async () => response(await handlers.discover_locks())
);

server.registerTool(
  "health_check",
  {
    title: "Health Check",
    description: "Check credentials, Eufy connectivity, local mappings, and mapped lock availability.",
    inputSchema: {}
  },
  async () => response(await handlers.health_check())
);

server.registerTool(
  "list_lock_codes",
  {
    title: "List Lock Codes",
    description: "List Eufy lock-code users and password metadata. Plaintext existing passcodes are never returned.",
    inputSchema: {
      ...targetSchema,
      allConfigured: z.boolean().optional()
    }
  },
  async (input) => response(await handlers.list_lock_codes(input))
);

server.registerTool(
  "plan_create_code",
  {
    title: "Plan Create Code",
    description: "Create a dry-run plan to add a lock-code user. Use execute_plan with the token to perform it.",
    inputSchema: {
      ...targetSchema,
      username: z.string(),
      passcode: z.string(),
      schedule: scheduleSchema,
      reason: z.string()
    }
  },
  async (input) => response(await handlers.plan_create_code(input))
);

server.registerTool(
  "plan_update_code",
  {
    title: "Plan Update Code",
    description: "Create a dry-run plan to update a user's passcode and/or schedule.",
    inputSchema: {
      ...targetSchema,
      username: z.string(),
      passcode: z.string().optional(),
      schedule: scheduleSchema,
      reason: z.string()
    }
  },
  async (input) => response(await handlers.plan_update_code(input))
);

server.registerTool(
  "plan_delete_code",
  {
    title: "Plan Delete Code",
    description: "Create a dry-run plan to delete a lock-code user by exact username.",
    inputSchema: {
      ...targetSchema,
      username: z.string(),
      reason: z.string()
    }
  },
  async (input) => response(await handlers.plan_delete_code(input))
);

server.registerTool(
  "plan_rotate_codes",
  {
    title: "Plan Rotate Codes",
    description: "Create a dry-run tenant/maintenance rotation plan. Replacement operations are ordered before deletes.",
    inputSchema: {
      ...targetSchema,
      oldUsername: z.string(),
      newUsername: z.string().optional(),
      newPasscode: z.string().optional(),
      passcode: z.string().optional(),
      schedule: scheduleSchema,
      reason: z.string()
    }
  },
  async (input) => response(await handlers.plan_rotate_codes(input))
);

server.registerTool(
  "execute_plan",
  {
    title: "Execute Plan",
    description: "Execute exactly one unexpired dry-run plan by confirmation token.",
    inputSchema: {
      confirmationToken: z.string().optional(),
      token: z.string().optional()
    }
  },
  async (input) => response(await handlers.execute_plan(input))
);

await server.connect(new StdioServerTransport());
