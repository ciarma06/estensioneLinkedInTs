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

/** Known "Reply" button labels (LinkedIn localized). */
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

function normalizeUiText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Comment action bar: often only hashed CSS classes (no stable comments-comment-social-bar).
 * The stable anchor is the "Reply" / "Rispondi" button.
 */
function findReplyActionButton(commentElement: HTMLElement): HTMLButtonElement | null {
  const buttons = commentElement.querySelectorAll('button');
  for (const btn of buttons) {
    const label = normalizeUiText(btn.textContent ?? '');
    if (REPLY_BUTTON_LABELS.has(label)) return btn;
    const aria = (btn.getAttribute('aria-label') ?? '').toLowerCase();
    if (
      aria &&
      aria.length < 120 &&
      (aria.includes('reply to') ||
        aria.includes('respond') ||
        aria.includes('rispondi') ||
        aria.includes('répondre'))
    ) {
      return btn;
    }
  }
  return null;
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
  if (commentElement.querySelector('.ln-save-btn')) return;

  const replyBtn = findReplyActionButton(commentElement);
  if (replyBtn?.parentElement) {
    const replyWrapper = replyBtn.parentElement;
    if (replyWrapper.nextElementSibling?.classList.contains('ln-save-inline-wrap')) return;
  }

  const socialBar = findCommentSocialBarLegacy(commentElement);
  if (!replyBtn?.parentElement && !socialBar) return;

  const btn = buildSaveButton(commentElement);

  if (replyBtn?.parentElement) {
    applyTypographyFromReference(findButtonTypographyLeaf(replyBtn), btn);
    const replyWrapper = replyBtn.parentElement;
    const wrap = document.createElement('div');
    wrap.className = 'ln-save-inline-wrap';
    const divider = document.createElement('div');
    divider.className = 'ln-save-divider';
    divider.setAttribute('role', 'presentation');
    wrap.appendChild(divider);
    wrap.appendChild(btn);
    replyWrapper.insertAdjacentElement('afterend', wrap);
    return;
  }

  if (!socialBar) return;

  const hashMatch = socialBar.className.toString().match(/comments-comment-social-bar--([a-z0-9]+)/i);
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