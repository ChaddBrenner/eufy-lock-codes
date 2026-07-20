import { maskPasscode } from "./redact.mjs";

export function validatePasscode(passcode, policy = {}) {
  const value = String(passcode ?? "");
  const minLength = Number.isInteger(policy.minLength) ? policy.minLength : 4;
  const maxLength = Number.isInteger(policy.maxLength) ? policy.maxLength : 8;
  const requireNumeric = policy.requireNumeric !== false;

  if (value.length < minLength || value.length > maxLength) {
    throw new Error(`Passcode must be between ${minLength} and ${maxLength} digits long`);
  }
  if (requireNumeric && !/^\d+$/.test(value)) {
    throw new Error("Passcode must contain only numbers");
  }
  return value;
}

export function publicOperation(operation) {
  const clone = { ...operation };
  delete clone.expectedPinPasswordIds;
  delete clone.expectedUser;
  if (clone.passcode !== undefined) {
    clone.passcodeMasked = maskPasscode(clone.passcode);
    delete clone.passcode;
  }
  return clone;
}
