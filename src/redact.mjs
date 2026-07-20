const SECRET_KEY_RE = /(pass|password|passcode|token|secret|auth|credential|eufy_email|eufy_pass)/i;
const SERIAL_RE = /\bT\d{4}[A-Z0-9]{8,}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_RE = /\b(?:gho|ghp|github_pat|sk-[A-Za-z0-9_-]*|sk-proj-[A-Za-z0-9_-]*)[A-Za-z0-9_-]{8,}\b/g;
const LABELED_PIN_RE = /\b(passcode|password|pin)(\s*[:=]\s*|\s+)(\d{4,8})\b/gi;

export function maskPasscode(passcode) {
  if (passcode === undefined || passcode === null || passcode === "") return undefined;
  const value = String(passcode);
  if (value.length <= 2) return "*".repeat(value.length);
  return `${"*".repeat(Math.max(0, value.length - 2))}${value.slice(-2)}`;
}

function redactString(value) {
  return value
    .replace(TOKEN_RE, "[redacted-token]")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(SERIAL_RE, "[redacted-serial]")
    .replace(LABELED_PIN_RE, "$1$2[redacted-passcode]");
}

export function redact(value) {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (SECRET_KEY_RE.test(key)) {
          if (/passcode/i.test(key) && typeof item === "string") return [key, maskPasscode(item)];
          return [key, "[redacted]"];
        }
        return [key, redact(item)];
      })
    );
  }
  if (typeof value === "string") return redactString(value);
  return value;
}

export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redact({ name: error?.name ?? "Error", message });
}
