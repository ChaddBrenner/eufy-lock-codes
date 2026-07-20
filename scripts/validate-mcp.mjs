#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const rootDir = process.cwd();
const packageJson = readJson(path.join(rootDir, "package.json"));
const mcpJson = readJson(path.join(rootDir, ".mcp.json"));
const server = mcpJson.mcpServers?.["eufy-lock-codes"];

assert(packageJson.name === "eufy-lock-codes", "package name must be eufy-lock-codes");
assert(packageJson.type === "module", "package must be ESM");
assert(packageJson.main === "mcp/server.mjs", "package main must point at the MCP server");
assert(packageJson.license === "AGPL-3.0-only", "license must be AGPL-3.0-only");
assert(server, ".mcp.json must define eufy-lock-codes");
assert(server.command === "node", "MCP server command must be node");
assert(Array.isArray(server.args) && server.args.includes("./mcp/server.mjs"), "MCP server args must include ./mcp/server.mjs");
assert(fs.existsSync(path.join(rootDir, "mcp", "server.mjs")), "MCP server file is missing");
assert(fs.existsSync(path.join(rootDir, "config", "properties.example.yaml")), "example property config is missing");

console.log("MCP metadata validation passed");
