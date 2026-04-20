// src/moduli/profileSaver.ts
import { apiSaveProfile } from './apiClient';
import { getStoredAuth, isAccessStillValid } from './authService';

export interface LinkedInProfile {
  full_name: string;
  linkedin_url: string;
  comment_text: string;
  comment_url: string;
}

export const extractNameFromUrl = (url: string): string => {
  try {
    const match = url.match(/\/in\/([^\/?#]+)/);
    if (!match || !match[1]) return "LinkedIn user";

    let slug = match[1];
    let slugParts = slug.split('-');

    if (slugParts.length > 1 && /\d/.test(slugParts[slugParts.length - 1])) {
        slugParts.pop();
    }

    return slugParts
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

  } catch (e) {
    return "LinkedIn user";
  }
};

/** URN commento dal DOM legacy (data-id) o feed nuovo (componentkey). */
function resolveCommentUrnParts(commentElement: HTMLElement): {
  commentUrn: string;
  type: string;
  postId: string;
  commentId: string;
} | null {
  const dataId = commentElement.getAttribute('data-id');
  if (dataId) {
    const match = dataId.match(/urn:li:comment:\((ugcPost|activity):(\d+),(\d+)\)/);
    if (match) {
      return { commentUrn: dataId, type: match[1], postId: match[2], commentId: match[3] };
    }
  }
  const ck = commentElement.getAttribute('componentkey');
  if (ck?.startsWith('replaceableComment_')) {
    const inner = ck.replace(/^replaceableComment_/, '');
    const match = inner.match(/urn:li:comment:\(urn:li:(ugcPost|activity):(\d+),(\d+)\)/);
    if (match) {
      return { commentUrn: inner, type: match[1], postId: match[2], commentId: match[3] };
    }
  }
  return null;
}

export const extractProfileFromComment = (commentElement: HTMLElement): LinkedInProfile | null => {
  // 1. Profile link and name — first /in/ may be avatar only (figure); prefer link without figure.
  const inLinks = Array.from(
    commentElement.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'),
  ).filter((a) => /\/in\/[^/?#]+/i.test(a.href));
  const linkElement =
    inLinks.find((a) => !a.querySelector('figure')) ?? inLinks[0];
  if (!linkElement) return null;

  const nameElement = linkElement.querySelector(
    '.comments-comment-meta__name-text, span[aria-hidden="true"], span[dir="ltr"]',
  );
  let extractedName = nameElement?.textContent?.trim() || '';

  if (!extractedName || extractedName === '') {
    extractedName = extractNameFromUrl(linkElement.href);
  } else {
    extractedName = extractedName.replace(/\s+/g, ' ').trim();
  }

  const linkedin_url = linkElement.href.split('?')[0];

  // 2. TESTO DEL COMMENTO
  const textElement = commentElement.querySelector(
    '[data-testid="expandable-text-box"], .update-components-text, .comments-comment-item__main-content span[dir="ltr"]',
  );
  const comment_text = textElement?.textContent?.trim() || 'Testo non disponibile';

  // 3. URL del commento (deep link feed)
  let comment_url = window.location.href;
  const urnParts = resolveCommentUrnParts(commentElement);
  if (urnParts) {
    const { commentUrn, type, postId, commentId } = urnParts;
    const dashCommentUrn = `urn:li:fsd_comment:(${commentId},urn:li:${type}:${postId})`;
    comment_url = `https://www.linkedin.com/feed/update/urn:li:${type}:${postId}?commentUrn=${encodeURIComponent(commentUrn)}&dashCommentUrn=${encodeURIComponent(dashCommentUrn)}`;
  }

  return {
    full_name: extractedName,
    linkedin_url,
    comment_text,
    comment_url,
  };
};

export const saveToCRM = async (profile: LinkedInProfile) => {
  const auth = await getStoredAuth();
  if (!auth || !isAccessStillValid(auth)) {
    alert('Accedi a Linky Assistant dal sidepanel per salvare i profili.');
    return;
  }

  const result = await apiSaveProfile({
    full_name: profile.full_name,
    linkedin_url: profile.linkedin_url,
    comment_text: profile.comment_text,
    comment_url: profile.comment_url,
  });

  if ('error' in result) {
    if (result.authExpired) {
      alert('Sessione scaduta, riapri il sidepanel.');
    } else {
      alert('Could not save: ' + result.error);
    }
    throw new Error(result.error);
  }
};