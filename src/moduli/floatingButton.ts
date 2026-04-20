/**
 * Bottone floating CRM (solo pagina LinkedIn).
 * Importare esclusivamente da `src/content/index.ts` — mai da crm/sidepanel.
 */

const FLOATING_CRM_BTN_ID = 'ai-crm-floating-btn';
const FLOATING_CRM_BTN_CLASS = 'ln-crm-floating-btn';

/** Solo documento della tab LinkedIn (mai sidepanel/extension/localhost dev). */
function isLinkedInWebPage(): boolean {
  if (typeof location === 'undefined') return false;
  const h = (location.hostname || '').toLowerCase();
  return h === 'linkedin.com' || h === 'www.linkedin.com';
}

export function injectFloatingCRMButton(): void {
  if (!isLinkedInWebPage()) return;
  if (window !== window.top) return;

  const existing = Array.from(document.querySelectorAll<HTMLElement>(`.${FLOATING_CRM_BTN_CLASS}`));
  if (existing.length > 1) {
    existing.forEach((el, i) => {
      if (i > 0) el.remove();
    });
    return;
  }
  if (existing.length === 1) return;

  const btn = document.createElement('button');
  btn.id = FLOATING_CRM_BTN_ID;
  btn.className = FLOATING_CRM_BTN_CLASS;
  btn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        d="M3.75 7.75a2 2 0 0 1 2-2h4.05c.4 0 .78.16 1.06.44l1.14 1.14c.28.28.66.44 1.06.44h5.19a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2v-8.5Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  `;
  btn.title = 'Open or close Lead Library';
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'toggle_side_panel' });
  });
  document.body.appendChild(btn);
}
