/** chrome.storage keys (CRM settings) */
export const LN_USER_VALUE_PROP_KEY = 'ln_user_value_prop';
export const LN_USER_TARGET_LANGUAGE_KEY = 'ln_user_target_language';
export const LN_USER_AI_INSTRUCTIONS_KEY = 'ln_user_ai_instructions';

export const TARGET_LANGUAGES = ['Italiano', 'Inglese', 'Spagnolo', 'Tedesco'] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

const DEFAULT_TARGET_LANGUAGE: TargetLanguage = 'Inglese';

const isTargetLanguage = (value: unknown): value is TargetLanguage => {
  return (
    typeof value === 'string' &&
    TARGET_LANGUAGES.includes(value as TargetLanguage)
  );
};

export function getValueProposition(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get([LN_USER_VALUE_PROP_KEY], (r) => {
      resolve(String(r[LN_USER_VALUE_PROP_KEY] ?? '').trim());
    });
  });
}

export function getUserInstructions(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get([LN_USER_AI_INSTRUCTIONS_KEY], (r) => {
      resolve(String(r[LN_USER_AI_INSTRUCTIONS_KEY] ?? '').trim());
    });
  });
}

export function getTargetLanguage(): Promise<TargetLanguage> {
  return new Promise((resolve) => {
    chrome.storage.local.get([LN_USER_TARGET_LANGUAGE_KEY], (r) => {
      const stored = r[LN_USER_TARGET_LANGUAGE_KEY];
      resolve(isTargetLanguage(stored) ? stored : DEFAULT_TARGET_LANGUAGE);
    });
  });
}
