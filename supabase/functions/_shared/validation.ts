const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 254 && EMAIL_RE.test(s);
}

export function isValidOtp(s: unknown): s is string {
  return typeof s === "string" && /^\d{6}$/.test(s);
}
