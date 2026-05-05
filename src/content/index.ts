// src/content/index.ts
import '../style.css';
import '../content-floating-crm.css';
import { extractProfileFromComment, saveToCRM } from '../moduli/profileSaver';
import { injectFloatingCRMButton } from '../moduli/floatingButton';
import { injectAIGenerateButton, observeMessagingForms } from '../moduli/messageGenerator';

(window as any).__lnScriptTime = new Date().toISOString();

/** Comment DOM: legacy BEM or React root with URN on componentkey (new feed). */
const COMMENT_ROOT_SELECTOR =
  '.comments-comment-entity, [componentkey^="replaceableComment_"]' as const;

function queryCommentRoots(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(COMMENT_ROOT_SELECTOR));
}

/** Known "Reply" button labels (LinkedIn localized) — matched against textContent. */
const REPLY_BUTTON_LABELS = new Set([
  'Rispondi',
  'Reply',
  'Responder',
  'Répondre',
  'Antworten',
  'Antwoord',
  'Svar',
  'Odpowiedz',
  'Ответить',
  '回答',
  '回覆',
]);

/**
 * Exact aria-label values for the Reply button in the new icon-only DOM.
 * Kept separate from REPLY_BUTTON_LABELS to allow independent evolution.
 */
const REPLY_ARIA_LABELS_EXACT = new Set([
  'Reply',
  'Rispondi',
  'Responder',
  'Répondre',
  'Antworten',
  'Antwoord',
  'Svar',
  'Odpowiedz',
  'Ответить',
  '回答',
  '回覆',
]);

function normalizeUiText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Comment action bar: often only hashed CSS classes (no stable comments-comment-social-bar).
 * The stable anchor is the "Reply" / "Rispondi" button.
 *
 * Priority (first match wins):
 *   1. textContent exact match against REPLY_BUTTON_LABELS
 *   2. aria-label exact match against REPLY_ARIA_LABELS_EXACT
 *      (skip buttons whose aria-label contains "reactions menu")
 *   3. aria-label substring match (legacy: "reply to …", "rispondi …", etc.)
 *   4. Structural fallback: button contains svg#comment-small with no text
 */
function findReplyActionButton(commentElement: HTMLElement): HTMLButtonElement | null {
  const buttons = commentElement.querySelectorAll('button');
  for (const btn of buttons) {
    // 1. textContent exact match
    const label = normalizeUiText(btn.textContent ?? '');
    if (REPLY_BUTTON_LABELS.has(label)) return btn;

    const ariaRaw = btn.getAttribute('aria-label') ?? '';
    const ariaLower = ariaRaw.toLowerCase();

    // Exclude the "Open reactions menu" chevron button
    if (ariaLower.includes('reactions menu')) continue;

    // 2. aria-label exact match (new icon-only Reply button)
    if (REPLY_ARIA_LABELS_EXACT.has(normalizeUiText(ariaRaw))) return btn;

    // 3. aria-label substring match (legacy patterns)
    if (
      ariaRaw &&
      ariaLower.length < 120 &&
      (ariaLower.includes('reply to') ||
        ariaLower.includes('respond') ||
        ariaLower.includes('rispondi') ||
        ariaLower.includes('répondre'))
    ) {
      return btn;
    }

    // 4. Structural fallback: icon-only Reply identified by svg#comment-small
    if (
      btn.querySelector('svg#comment-small') !== null &&
      normalizeUiText(btn.textContent ?? '') === ''
    ) {
      return btn;
    }
  }
  return null;
}

/**
 * New DOM: locate the action bar that contains the Reply button.
 *
 * Structure (new hashed-class feed):
 *   <div class="...">                     ← ACTION BAR
 *     <div class="...">                   ← reaction wrapper
 *       <div role="button">…</div>
 *       <button aria-label="Open reactions menu">…</button>
 *     </div>
 *     <div class="...">                   ← replyWrapper (direct child of action bar)
 *       <button aria-label="Reply">…</button>
 *     </div>
 *   </div>
 *
 * We climb: replyBtn → closest div (replyWrapper) → parentElement (action bar).
 * Validation: action bar must be inside the comment element and have ≥ 2 div children.
 */
function findCommentActionBarNew(
  commentElement: HTMLElement,
  replyBtn: HTMLButtonElement,
): HTMLElement | null {
  const replyWrapper = replyBtn.closest('div');
  if (!replyWrapper) return null;
  const actionBar = replyWrapper.parentElement;
  if (!actionBar || !(actionBar instanceof HTMLElement)) return null;
  if (!commentElement.contains(actionBar)) return null;
  const directDivChildren = Array.from(actionBar.children).filter(
    (c): c is HTMLElement => c.tagName === 'DIV',
  );
  if (directDivChildren.length < 2) return null;
  if (!directDivChildren.includes(replyWrapper)) return null;
  return actionBar;
}

/** Legacy DOM (LinkedIn BEM classes) before hashed CSS. */
function findCommentSocialBarLegacy(commentElement: HTMLElement): HTMLElement | null {
  const legacy = commentElement.querySelector<HTMLElement>('.comments-comment-social-bar--cr');
  if (legacy) return legacy;
  for (const el of commentElement.querySelectorAll<HTMLElement>('[class*="comments-comment-social-bar"]')) {
    const tokens = (typeof el.className === 'string' ? el.className : String(el.className)).split(/\s+/);
    for (const t of tokens) {
      if (/^comments-comment-social-bar--[a-z0-9]+$/i.test(t)) return el;
    }
  }
  return null;
}

/** Text leaf inside the button (e.g. span "Reply") — font size matches the feed there. */
function findButtonTypographyLeaf(btn: HTMLButtonElement): Element {
  const leaves = Array.from(btn.querySelectorAll<HTMLElement>('span')).filter(
    (s) => s.childElementCount === 0 && (s.textContent?.trim().length ?? 0) > 0,
  );
  const replyLabel = leaves.find((s) => REPLY_BUTTON_LABELS.has(normalizeUiText(s.textContent ?? '')));
  if (replyLabel) return replyLabel;
  if (leaves.length) return leaves[leaves.length - 1];
  return btn;
}

/**
 * LinkedIn uses very specific button fonts; our content-script CSS loses the cascade.
 * Copy computed styles from the Reply button (prefer its text leaf) with inline !important.
 */
function applyTypographyFromReference(reference: Element, target: HTMLButtonElement) {
  const cs = window.getComputedStyle(reference);
  const s = target.style;
  s.setProperty('font-size', cs.fontSize, 'important');
  s.setProperty('font-family', cs.fontFamily, 'important');
  s.setProperty('font-weight', cs.fontWeight, 'important');
  s.setProperty('line-height', cs.lineHeight, 'important');
  s.setProperty('letter-spacing', cs.letterSpacing, 'important');
  s.setProperty('color', cs.color, 'important');
  const label = target.querySelector<HTMLElement>('.ln-save-btn__text');
  if (label) {
    label.style.setProperty('font-size', 'inherit', 'important');
    label.style.setProperty('font-weight', 'inherit', 'important');
    label.style.setProperty('line-height', 'inherit', 'important');
    label.style.setProperty('color', 'inherit', 'important');
  }
}

function buildSaveButton(commentElement: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ln-save-btn';
  btn.setAttribute('aria-label', 'Save to Lead Library');
  btn.innerHTML = `<span class="ln-save-btn__text">Save</span>`;

  btn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const data = extractProfileFromComment(commentElement);
    if (data) {
      await saveToCRM(data);
      const textSpan = btn.querySelector<HTMLElement>('.ln-save-btn__text');
      if (textSpan) textSpan.textContent = '✅ Saved';
    }
  };
  return btn;
}

const injectSaveButton = (commentElement: HTMLElement) => {
  // ── LEGACY PATH ──
  // socialBar has stable BEM class; idempotency checked on the bar itself.
  const socialBar = findCommentSocialBarLegacy(commentElement);
  if (socialBar) {
    if (socialBar.querySelector('.ln-save-btn')) return;
    const btn = buildSaveButton(commentElement);
    const hashMatch = socialBar.className
      .toString()
      .match(/comments-comment-social-bar--([a-z0-9]+)/i);
    const suffix = hashMatch?.[1] ?? 'cr';
    const actionGroup = document.createElement('div');
    actionGroup.className = `comments-comment-social-bar__action-group--${suffix}`;
    const divider = document.createElement('div');
    divider.className = 'comments-comment-social-bar__vertical-divider ln-save-divider';
    socialBar.appendChild(divider);
    socialBar.appendChild(actionGroup);
    actionGroup.appendChild(btn);
    const legacyRef = socialBar.querySelector<HTMLButtonElement>('button');
    if (legacyRef) applyTypographyFromReference(findButtonTypographyLeaf(legacyRef), btn);
    return;
  }

  // ── NEW DOM PATH ──
  // No BEM social bar: locate the Reply button and climb to the action bar.
  const replyBtn = findReplyActionButton(commentElement);
  if (!replyBtn) return;
  const actionBar = findCommentActionBarNew(commentElement, replyBtn);
  if (!actionBar) return;
  // Idempotency: checked on the action bar to survive partial re-renders.
  if (actionBar.querySelector('.ln-save-btn')) return;

  const btn = buildSaveButton(commentElement);
  // Reply is icon-only in the new DOM: copying its computed styles would give icon-sized
  // values. Skip applyTypographyFromReference and let the CSS fallbacks take over.

  const wrap = document.createElement('div');
  wrap.className = 'ln-save-inline-wrap ln-save-wrap--new';
  wrap.appendChild(btn);
  actionBar.appendChild(wrap);
};

const scanAndInject = () => {
  const comments = queryCommentRoots();
  injectFloatingCRMButton();
  injectAIGenerateButton();
  comments.forEach((c) => {
    if (!c.querySelector('.ln-save-btn')) injectSaveButton(c);
  });
};

// ─────────────────────────────────────────────
// OBSERVER: run when comments appear in the DOM
// ─────────────────────────────────────────────
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches(COMMENT_ROOT_SELECTOR)) {
        injectSaveButton(node);
      } else {
        queryCommentRoots(node).forEach(injectSaveButton);
      }
    }
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true });

// ─────────────────────────────────────────────
// HEARTBEAT: scan every 2 seconds
// After SPA navigation, comments may appear only when the user expands them;
// timing is unpredictable.
// ─────────────────────────────────────────────
setInterval(() => {
  const comments = queryCommentRoots();
  const articles = document.querySelectorAll('article');
  const body = document.body?.children.length;
  void comments;
  void articles;
  void body;
  injectAIGenerateButton();
  if (comments.length > 0) {
    comments.forEach((c) => {
      if (!c.querySelector('.ln-save-btn')) injectSaveButton(c);
    });
  }
}, 2000);

// Initial run
injectFloatingCRMButton();
scanAndInject();
observeMessagingForms();

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'spa_navigation') {
    injectAIGenerateButton();
  }
});

export {};