import path from "node:path";
import dotenv from "dotenv";

export function loadEnv(rootDir = process.cwd(), env = process.env, { readDotenv = env === process.env } = {}) {
  if (readDotenv) dotenv.config({ path: path.join(rootDir, ".env"), override: false, quiet: true });
  const username = env.eufy_email;
  const password = env.eufy_pass;
  const missing = [];
  if (!username) missing.push("eufy_email");
  if (!password) missing.push("eufy_pass");

  return {
    ok: missing.length === 0,
    missing,
    config: {
      username,
      password,
      country: (env.EUFY_COUNTRY || "US").toUpperCase(),
      language: env.EUFY_LANGUAGE || "en"
    }
  };
}

export function requireEnv(rootDir = process.cwd(), env = process.env) {
  const loaded = loadEnv(rootDir, env);
  if (!loaded.ok) {
    throw new Error(`Missing required Eufy environment keys: ${loaded.missing.join(", ")}`);
  }
  return loaded.config;
}
