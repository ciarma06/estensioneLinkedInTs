// src/moduli/messagingContext.ts
import { apiSearchProfile, type Profile } from './apiClient';

/** Allineato ai 3 framework in .cursorrules */
export type MessageScenario = 'pain' | 'founder' | 'trigger';

export type MessagingHeaderContext = {
  leadName: string | null;
  headline: string | null;
  profileUrl: string | null;
};

export type TriggerFromCrm = {
  fullName: string | null;
  commentText: string | null;
  commentUrl: string | null;
  linkedinUrl: string | null;
};

export type MessagingContext = {
  scenario: MessageScenario;
  header: MessagingHeaderContext;
  trigger: TriggerFromCrm | null;
};

const PROFILE_LINK_SELECTORS = [
  'header.msg-title-bar a[href*="/in/"]',
  'a.msg-thread__link-to-profile[href*="/in/"]',
  '.msg-title-bar a[href*="/in/"]',
  '[data-test-id="conversation-header"] a[href*="/in/"]',
  '.msg-s-message-list__entity-lockup a[href*="/in/"]',
  'a[href*="linkedin.com/in/"]',
];

const NAME_SELECTORS = [
  'h2.msg-entity-lockup__entity-title',
  '.msg-entity-lockup__entity-title',
  '.msg-title-bar h2',
  '[data-test-id="conversation-header"] h2',
];

const HEADLINE_SELECTORS = [
  '.msg-entity-lockup__entity-subtitle',
  '.msg-entity-lockup__entity-info',
  '.msg-title-bar .msg-entity-lockup__entity-subtitle',
];

export function normalizeLinkedInProfileUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('linkedin.com')) return url.split('?')[0].replace(/\/$/, '');
    const path = u.pathname.replace(/\/$/, '');
    return `${u.origin}${path}`;
  } catch {
    return url.split('?')[0].replace(/\/$/, '');
  }
}

function firstText(selectors: string[]): string | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const t = el?.textContent?.replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return null;
}

function findProfileLink(): HTMLAnchorElement | null {
  for (const sel of PROFILE_LINK_SELECTORS) {
    const el = document.querySelector<HTMLAnchorElement>(sel);
    if (el?.href?.includes('/in/')) return el;
  }
  return null;
}

export function scrapeMessagingHeader(): MessagingHeaderContext {
  const profileLink = findProfileLink();
  const profileUrl = profileLink?.href ? normalizeLinkedInProfileUrl(profileLink.href) : null;

  let leadName = firstText(NAME_SELECTORS);
  if (!leadName && profileLink) {
    leadName = profileLink.textContent?.replace(/\s+/g, ' ').trim() || null;
  }

  const headline = firstText(HEADLINE_SELECTORS);

  return {
    leadName,
    headline,
    profileUrl,
  };
}

function profileToTrigger(p: Profile): TriggerFromCrm {
  return {
    fullName: p.full_name ?? null,
    commentText: p.comment_text ?? null,
    commentUrl: p.comment_url ?? null,
    linkedinUrl: p.linkedin_url ?? null,
  };
}

async function fetchTriggerByProfileUrl(profileUrl: string): Promise<TriggerFromCrm | null> {
  const result = await apiSearchProfile(profileUrl);
  if ('error' in result) return null;
  if (!result.profile) return null;
  return profileToTrigger(result.profile);
}

export async function getMessagingContext(scenario: MessageScenario): Promise<MessagingContext> {
  const header = scrapeMessagingHeader();

  let trigger: TriggerFromCrm | null = null;
  if (scenario === 'trigger' && header.profileUrl) {
    try {
      trigger = await fetchTriggerByProfileUrl(header.profileUrl);
    } catch (e) {
      console.warn('[LN-EXT] getMessagingContext: trigger fetch failed', e);
      trigger = null;
    }
  }

  return { scenario, header, trigger };
}
