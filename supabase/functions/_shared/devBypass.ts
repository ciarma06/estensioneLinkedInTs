/** Dev-only OTP bypass. Disabled when DEV_TEST_EMAILS is unset or empty. */

export function getDevTestEmailWhitelist(): Set<string> | null {
  const raw = Deno.env.get("DEV_TEST_EMAILS")?.trim();
  if (!raw) return null;
  const emails = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  if (emails.length === 0) return null;
  return new Set(emails);
}

export function getDevTestOtp(): string | null {
  const otp = Deno.env.get("DEV_TEST_OTP")?.trim();
  return otp && otp.length > 0 ? otp : null;
}

export function isDevBypassRequestEmail(
  email: string,
  whitelist: Set<string> | null,
): boolean {
  return whitelist !== null && whitelist.has(email);
}

export function isDevBypassVerify(
  email: string,
  code: string,
  whitelist: Set<string> | null,
  devOtp: string | null,
): boolean {
  return (
    whitelist !== null &&
    devOtp !== null &&
    whitelist.has(email) &&
    code === devOtp
  );
}
