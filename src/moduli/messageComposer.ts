const COMPOSER_SELECTOR = '.msg-form__contenteditable';
const CONTENTEDITABLE_SELECTOR = 'div[contenteditable="true"][role="textbox"]';

function getAllSearchRoots(): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = [document];
  const interopOutlet = document.querySelector<HTMLElement>('#interop-outlet');
  if (interopOutlet?.shadowRoot) {
    roots.push(interopOutlet.shadowRoot);
  }
  return roots;
}

function findVisibleComposerInRoot(root: Document | ShadowRoot): HTMLElement | null {
  const nodes = root.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR);
  return Array.from(nodes).find((el) => el.offsetParent !== null) ?? null;
}

function findBestComposer(anchor?: Element | null): HTMLElement | null {
  // 1) Best-effort: search relative to the clicked AI button (works inside Shadow DOM too)
  if (anchor) {
    const formContainer =
      anchor.closest('form') ??
      anchor.closest('.msg-form') ??
      anchor.closest('.msg-form__form') ??
      anchor.closest('.msg-form__right-actions')?.closest('form') ??
      anchor.closest('.msg-form__right-actions')?.parentElement ??
      anchor.parentElement;

    if (formContainer) {
      const local =
        formContainer.querySelector<HTMLElement>(CONTENTEDITABLE_SELECTOR) ??
        formContainer.querySelector<HTMLElement>(COMPOSER_SELECTOR);
      if (local) return local;
    }
  }

  // 2) Fallback: scan all known roots (document + interop-outlet shadow root)
  for (const root of getAllSearchRoots()) {
    const found = findVisibleComposerInRoot(root);
    if (found) return found;
    const any =
      root.querySelector<HTMLElement>(CONTENTEDITABLE_SELECTOR) ??
      root.querySelector<HTMLElement>(COMPOSER_SELECTOR);
    if (any) return any;
  }

  return null;
}

/**
 * Clears the composer, inserts `<p>` blocks, simulates input (LinkedIn enables Send).
 */
export function insertAiMessageIntoComposer(plainText: string): boolean {
  return insertAiMessageIntoComposerNear(plainText, null);
}

export function insertAiMessageIntoComposerNear(
  plainText: string,
  anchorEl: Element | null,
): boolean {
  const el = findBestComposer(anchorEl);
  if (!el || el.getAttribute('contenteditable') !== 'true') {
    return false;
  }

  const text = plainText.trim();
  el.focus();

  // Simpler insertion that works consistently in popup/shadow contexts.
  el.innerHTML = `<p>${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;

  el.dispatchEvent(new Event('input', { bubbles: true }));
  try {
    if (typeof InputEvent !== 'undefined') {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        }),
      );
    }
  } catch {
    /* InputEvent optional for LinkedIn */
  }

  return true;
}
