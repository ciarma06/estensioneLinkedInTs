/**
 * Allowlist statica di email abilitate al tier "premium plus" (accesso a LinkdAPI).
 *
 * TODO: spostare in tabella DB quando il pricing tier sarà definito,
 * insieme alla colonna `tier` su `utenti` / `utenti_waitlist`.
 */
const PREMIUM_PLUS_EMAILS: string[] = [
  // aggiungere email qui
  'davidciarmatori@gmail.com',
];

export function isPremiumPlus(email: string | null | undefined): boolean {
  if (!email) return false;
  return PREMIUM_PLUS_EMAILS.includes(email.toLowerCase().trim());
}
