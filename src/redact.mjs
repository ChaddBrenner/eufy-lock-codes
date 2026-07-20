const SECRET_KEY_RE = /(pass|password|passcode|token|secret|auth|credential|eufy_email|eufy_pass)/i;

export function maskPasscode(passcode) {
  if (passcode === undefined || passcode === null || passcode === "") return undefined;
  const value = String(passcode);
  if (value.length <= 2) return "*".repeat(value.length);
  return `${"*".repeat(Math.max(0, value.length - 2))}${value.slice(-2)}`;
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
  return value;
}

export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redact({ name: error?.name ?? "Error", message });
}
