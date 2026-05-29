//messageGenerator.ts

import { getMessagingContext, type MessageScenario } from './messagingContext';
import { getTargetLanguage, getUserInstructions, getValueProposition } from './userSettings';
import { insertAiMessageIntoComposerNear } from './messageComposer';
import { supabase } from './supabase';
import { getStoredAuth, isAccessStillValid, getJwt } from './authService';

const QUOTA_STORAGE_KEY = 'linky_message_quota';
const PRICING_URL = 'https://linkyassistant.com/#pricing';

type ParsedFunctionsError = {
  status?: number;
  body?: Record<string, unknown>;
  message: string;
};

/**
 * Estrae status + body + messaggio da un errore di supabase.functions.invoke.
 * Consuma `error.context.json()` una sola volta.
 */
async function parseFunctionsInvokeError(error: unknown): Promise<ParsedFunctionsError> {
  if (!error || typeof error !== 'object') return { message: String(error) };
  const e = error as {
    message?: string;
    context?: { status?: number; json?: () => Promise<unknown> };
  };
  const status = e.context?.status;
  let body: Record<string, unknown> | undefined;
  if (e.context && typeof e.context.json === 'function') {
    try {
      body = (await e.context.json()) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  const message =
    (typeof body?.error === 'string' ? body.error : undefined) ??
    e.message ??
    String(error);
  return { status, body, message };
}

async function persistQuotaUpdate(
  quota: { used?: unknown; limit?: unknown } | null,
): Promise<void> {
  try {
    // Conserva plan / periodEnd dalla cache (vengono settati dal fetch a
    // get-message-quota nel sidepanel): la response di generate-message non
    // li include, quindi senza il merge li perderemmo a ogni generazione.
    const existing = await chrome.storage.local.get(QUOTA_STORAGE_KEY);
    const prev = (existing[QUOTA_STORAGE_KEY] ?? null) as
      | { plan?: unknown; periodEnd?: unknown }
      | null;
    const prevPlan =
      prev && (prev.plan === 'assistant' || prev.plan === 'scout' || prev.plan === 'bundle')
        ? (prev.plan as 'assistant' | 'scout' | 'bundle')
        : null;
    const prevPeriodEnd =
      prev && typeof prev.periodEnd === 'string' ? prev.periodEnd : null;

    if (!quota) {
      // Per il trial waitlist: nessuna quota mensile, mostra UI "trial"
      await chrome.storage.local.set({
        [QUOTA_STORAGE_KEY]: {
          used: null,
          limit: null,
          access: 'waitlist_trial',
          plan: null,
          periodEnd: null,
          checkedAt: Date.now(),
          source: 'message-generated',
        },
      });
      return;
    }
    const used = typeof quota.used === 'number' ? quota.used : null;
    const limit = typeof quota.limit === 'number' ? quota.limit : null;
    // `source: 'message-generated'` segnala al sidepanel di rifare un fetch
    // a get-message-quota per aggiornare anche la data di rinnovo (che la
    // response di generate-message non restituisce).
    await chrome.storage.local.set({
      [QUOTA_STORAGE_KEY]: {
        used,
        limit,
        access: 'premium',
        plan: prevPlan,
        periodEnd: prevPeriodEnd,
        checkedAt: Date.now(),
        source: 'message-generated',
      },
    });
  } catch (err) {
    console.error('[LN-EXT] quota storage update failed', err);
  }
}

/**
 * Mostra una modale di upgrade con un link cliccabile a `pricingUrl`.
 * Usata per: monthly_quota_exceeded e plan = scout (no assistant access).
 */
function showUpgradeModal(opts: { title: string; body: string; ctaLabel?: string }): void {
  const overlay = document.createElement('div');
  overlay.className = 'ln-upgrade-overlay';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.4)';
  overlay.style.zIndex = '99999';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';

  const dialog = document.createElement('div');
  dialog.style.maxWidth = '440px';
  dialog.style.width = '90%';
  dialog.style.background = '#ffffff';
  dialog.style.borderRadius = '10px';
  dialog.style.boxShadow = '0 16px 36px rgba(0,0,0,0.22)';
  dialog.style.padding = '20px 22px 18px';
  dialog.style.fontFamily =
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  const title = document.createElement('h2');
  title.textContent = opts.title;
  title.style.fontSize = '17px';
  title.style.margin = '0 0 8px';
  title.style.color = '#6d47f5';

  const body = document.createElement('p');
  body.textContent = opts.body;
  body.style.fontSize = '13px';
  body.style.lineHeight = '1.5';
  body.style.margin = '0 0 16px';
  body.style.color = 'rgba(0,0,0,0.78)';

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.justifyContent = 'flex-end';
  actions.style.gap = '8px';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.style.border = '1px solid rgba(0,0,0,0.14)';
  closeBtn.style.background = '#ffffff';
  closeBtn.style.fontSize = '13px';
  closeBtn.style.padding = '8px 14px';
  closeBtn.style.borderRadius = '999px';
  closeBtn.style.cursor = 'pointer';

  const upgradeLink = document.createElement('a');
  upgradeLink.href = PRICING_URL;
  upgradeLink.target = '_blank';
  upgradeLink.rel = 'noopener noreferrer';
  upgradeLink.textContent = opts.ctaLabel ?? 'Upgrade to Bundle';
  upgradeLink.style.border = 'none';
  upgradeLink.style.background = '#6d47f5';
  upgradeLink.style.color = '#ffffff';
  upgradeLink.style.fontSize = '13px';
  upgradeLink.style.fontWeight = '700';
  upgradeLink.style.padding = '8px 16px';
  upgradeLink.style.borderRadius = '999px';
  upgradeLink.style.textDecoration = 'none';
  upgradeLink.style.cursor = 'pointer';

  const cleanup = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown, true);
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cleanup();
    }
  };

  closeBtn.onclick = cleanup;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeydown, true);

  actions.appendChild(closeBtn);
  actions.appendChild(upgradeLink);
  dialog.appendChild(title);
  dialog.appendChild(body);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

const AI_BTN_ID = 'ln-ai-generate-btn';
const MENU_ID = 'ln-ai-generate-menu';
const WRAPPER_CLASS = 'ln-ai-generate-btn-wrapper';

const SCENARIO_OPTIONS: { scenario: MessageScenario; label: string }[] = [
  { scenario: 'pain', label: 'Pain point' },
  { scenario: 'trigger', label: 'Trigger (post/comment)' },
  { scenario: 'engage', label: 'Engage (recent posts)' },
];

let menuOpen = false;
let outsideListener: ((e: MouseEvent) => void) | null = null;
let escapeListener: ((e: KeyboardEvent) => void) | null = null;
let outsideAttachTimeout: ReturnType<typeof setTimeout> | null = null;

async function askForTriggerComments(): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ln-trigger-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.35)';
    overlay.style.zIndex = '99999';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    const dialog = document.createElement('div');
    dialog.className = 'ln-trigger-dialog';
    dialog.style.maxWidth = '480px';
    dialog.style.width = '100%';
    dialog.style.background = '#ffffff';
    dialog.style.borderRadius = '8px';
    dialog.style.boxShadow = '0 12px 30px rgba(0,0,0,0.18)';
    dialog.style.padding = '16px 18px 14px';
    dialog.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    const title = document.createElement('h2');
    title.textContent = 'Choose your trigger comments';
    title.style.fontSize = '16px';
    title.style.margin = '0 0 4px';

    const subtitle = document.createElement('p');
    subtitle.textContent =
      'Paste the LinkedIn comment(s) you want the AI to use as context. You can collect them from your Lead Library sidebar or directly from the feed.';
    subtitle.style.fontSize = '13px';
    subtitle.style.lineHeight = '1.5';
    subtitle.style.margin = '0 0 10px';

    const textarea = document.createElement('textarea');
    textarea.rows = 5;
    textarea.placeholder = 'Paste here the comment(s) you want to base your message on…';
    textarea.style.width = '100%';
    textarea.style.resize = 'vertical';
    textarea.style.fontSize = '13px';
    textarea.style.fontFamily = 'inherit';
    textarea.style.padding = '8px';
    textarea.style.borderRadius = '6px';
    textarea.style.border = '1px solid rgba(0,0,0,0.15)';
    textarea.style.boxSizing = 'border-box';
    textarea.style.marginBottom = '10px';

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '8px';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.border = 'none';
    cancelBtn.style.background = 'transparent';
    cancelBtn.style.fontSize = '13px';
    cancelBtn.style.cursor = 'pointer';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'Use comments';
    confirmBtn.style.border = 'none';
    confirmBtn.style.borderRadius = '999px';
    confirmBtn.style.padding = '6px 14px';
    confirmBtn.style.fontSize = '13px';
    confirmBtn.style.cursor = 'pointer';
    confirmBtn.style.background = '#0a66c2';
    confirmBtn.style.color = '#ffffff';

    const cleanup = () => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
    };

    const submit = () => {
      const value = textarea.value.trim();
      if (!value) {
        cleanup();
        resolve(null);
        return;
      }
      cleanup();
      resolve(value);
    };

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cleanup();
        resolve(null);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(null);
    };
    confirmBtn.onclick = submit;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    dialog.appendChild(title);
    dialog.appendChild(subtitle);
    dialog.appendChild(textarea);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    textarea.focus();
    document.addEventListener('keydown', onKeydown, true);
  });
}

function closeMenu(btn: HTMLButtonElement, menu: HTMLElement) {
  if (outsideAttachTimeout) {
    clearTimeout(outsideAttachTimeout);
    outsideAttachTimeout = null;
  }
  menuOpen = false;
  menu.classList.remove('ln-ai-dropdown--open');
  menu.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  if (outsideListener) {
    document.removeEventListener('click', outsideListener, true);
    outsideListener = null;
  }
  if (escapeListener) {
    document.removeEventListener('keydown', escapeListener, true);
    escapeListener = null;
  }
}

function openMenu(btn: HTMLButtonElement, menu: HTMLElement) {
  menuOpen = true;
  menu.hidden = false;
  menu.classList.add('ln-ai-dropdown--open');
  btn.setAttribute('aria-expanded', 'true');

  outsideListener = (e: MouseEvent) => {
    const t = e.target as Node | null;
    if (!t) return;
    const wrap = btn.closest(`.${WRAPPER_CLASS}`);
    if (wrap?.contains(t)) return;
    closeMenu(btn, menu);
  };
  outsideAttachTimeout = setTimeout(() => {
    outsideAttachTimeout = null;
    if (outsideListener && menuOpen) document.addEventListener('click', outsideListener, true);
  }, 0);

  escapeListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu(btn, menu);
      btn.focus();
    }
  };
  document.addEventListener('keydown', escapeListener, true);
}

function toggleMenu(btn: HTMLButtonElement, menu: HTMLElement) {
  if (menuOpen) closeMenu(btn, menu);
  else openMenu(btn, menu);
}

function setMenuBusy(btn: HTMLButtonElement, menu: HTMLElement, busy: boolean) {
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  menu.querySelectorAll('button').forEach((b) => {
    (b as HTMLButtonElement).disabled = busy;
  });
}

async function onScenarioChosen(
  scenario: MessageScenario,
  btn: HTMLButtonElement,
  menu: HTMLElement,
) {
  const auth = await getStoredAuth();
  if (!auth || !isAccessStillValid(auth)) {
    alert('Sign in to Linky Assistant from the side panel to generate messages.');
    closeMenu(btn, menu);
    return;
  }

  let manualTriggerText: string | null = null;

  if (scenario === 'trigger') {
    try {
      chrome.runtime.sendMessage({ action: 'open_side_panel' });
    } catch {
      // best-effort: sidebar is a UX enhancement, not critical path
    }

    manualTriggerText = await askForTriggerComments();
    if (!manualTriggerText) {
      closeMenu(btn, menu);
      return;
    }
  }

  setMenuBusy(btn, menu, true);
  try {
    const valueProposition = await getValueProposition();
    const targetLanguage = await getTargetLanguage();
    const aiInstructions = await getUserInstructions();

    const ctx = await getMessagingContext(scenario);

    const triggerText =
      scenario === 'trigger' && manualTriggerText
        ? manualTriggerText
        : ctx.trigger?.commentText ?? null;
    const triggerUrl =
      scenario === 'trigger' && manualTriggerText ? null : ctx.trigger?.commentUrl ?? null;

    const jwt = await getJwt();
    if (!jwt) {
      alert('Session expired. Please sign in again from the side panel.');
      closeMenu(btn, menu);
      return;
    }

    const { data, error } = await supabase.functions.invoke('generate-message', {
      headers: { 'x-supabase-authorization': `Bearer ${jwt}` },
      body: {
        scenario: ctx.scenario,
        valueProposition,
        leadName: ctx.header.leadName,
        headline: ctx.header.headline,
        profileUrl: ctx.header.profileUrl,
        triggerText,
        triggerUrl,
        targetLanguage,
        aiInstructions,
      },
    });

    if (error) {
      const parsed = await parseFunctionsInvokeError(error);
      const status = parsed.status;
      const body = parsed.body ?? {};

      // 402 — quota mensile esaurita
      if (status === 402 && body.error === 'monthly_quota_exceeded') {
        const limit = typeof body.limit === 'number' ? body.limit : null;
        const used = typeof body.used === 'number' ? body.used : null;
        // Aggiorna l'indicator: used = limit (esaurita)
        if (used !== null && limit !== null) {
          await persistQuotaUpdate({ used, limit });
        }
        const limitText = limit ?? 'all';
        const planText = limit && limit >= 500 ? 'a higher plan' : 'Bundle for 500 messages/mo';
        showUpgradeModal({
          title: 'Monthly limit reached',
          body: `You've used all ${limitText} messages for this period. Upgrade to ${planText}.`,
          ctaLabel: 'See pricing',
        });
        console.error('[LN-EXT] generate-message: monthly_quota_exceeded', { used, limit });
        closeMenu(btn, menu);
        return;
      }

      // 401 con reason = no_assistant_in_plan → utente con plan = scout
      if (status === 401 && body.reason === 'no_assistant_in_plan') {
        showUpgradeModal({
          title: 'AI messages not in your plan',
          body:
            'AI messages are not included in your Scout plan. Upgrade to Bundle to unlock the Assistant features.',
          ctaLabel: 'Upgrade to Bundle',
        });
        console.error('[LN-EXT] generate-message: plan denial', body);
        closeMenu(btn, menu);
        return;
      }

      // 401 / 403 generici → sessione scaduta
      if (status === 401 || status === 403) {
        alert('Session expired or invalid access. Please sign in again from the side panel.');
        closeMenu(btn, menu);
        return;
      }

      throw new Error(parsed.message);
    }

    const payload = data as {
      message?: string;
      error?: string;
      dataQuality?: 'enriched' | 'limited';
      dataQualityNote?: string;
      quota?: { used?: number; limit?: number } | null;
    } | null;
    if (payload?.error) {
      throw new Error(payload.error);
    }
    const aiMessage = payload?.message?.trim();
    if (!aiMessage) {
      throw new Error('Server response without a message.');
    }

    if (payload?.dataQuality === 'limited') {
      console.warn(
        '[LN-EXT] generate-message: dataQuality=limited',
        payload.dataQualityNote ?? '',
      );
    } else if (payload?.dataQuality === 'enriched') {
      console.info('[LN-EXT] generate-message: dataQuality=enriched');
    }

    // --- Refresh quota indicator (premium: { used, limit } | trial: null) ---
    if (payload && 'quota' in payload) {
      await persistQuotaUpdate(payload.quota ?? null);
    }

    const inserted = insertAiMessageIntoComposerNear(aiMessage, btn);
    if (!inserted) {
      console.warn('[LN-EXT] Composer insert failed');
      alert('Message generated but the message box was not found. Open a conversation and try again.');
    }
  } catch (e) {
    console.error('[LN-EXT] Message generation', e);
    const msg = e instanceof Error ? e.message : String(e);
    alert('Generation failed: ' + msg);
  } finally {
    setMenuBusy(btn, menu, false);
    closeMenu(btn, menu);
  }
}

function buildDropdown(): { wrapper: HTMLElement; btn: HTMLButtonElement; menu: HTMLElement } {
  const wrapper = document.createElement('div');
  wrapper.className = WRAPPER_CLASS;

  const btn = document.createElement('button');
  btn.id = AI_BTN_ID;
  btn.type = 'button';
  btn.className =
    'artdeco-button artdeco-button--1 artdeco-button--tertiary artdeco-button--muted ln-ai-generate-btn';
  btn.setAttribute('aria-label', 'Generate with Linky');
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', MENU_ID);
  btn.title = 'Generate with Linky';
  const linkyIconUrl = chrome.runtime.getURL('icons/linky_wizard_icon_no_background.png');
  btn.innerHTML = `<span class="artdeco-button__text"><img src="${linkyIconUrl}" aria-hidden="true" style="width:16px;height:16px;vertical-align:middle;margin-right:4px;"> <span>Generate with Linky</span><span class="ln-ai-dropdown__caret" aria-hidden="true">▾</span></span>`;

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'ln-ai-dropdown';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');

  for (const { scenario, label } of SCENARIO_OPTIONS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ln-ai-dropdown__item artdeco-button artdeco-button--2 artdeco-button--tertiary';
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void onScenarioChosen(scenario, btn, menu);
    });
    menu.appendChild(item);
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMenu(btn, menu);
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(menu);

  return { wrapper, btn, menu };
}

function hasAiBtnInSameComposer(el: Element): boolean {
  const scope =
    el.closest('footer.msg-form__footer') ??
    el.closest('form') ??
    el.closest('.msg-form') ??
    el.parentElement;
  return scope ? scope.querySelector('.ln-ai-generate-btn') != null : false;
}

function injectIntoRightActions(rightActions: HTMLElement) {
  if (hasAiBtnInSameComposer(rightActions)) return;
  if (rightActions.querySelector('.ln-ai-generate-btn')) return;

  const sendButton =
    rightActions.querySelector<HTMLButtonElement>('button.msg-form__send-button');
  if (!sendButton) {
    return;
  }

  const { wrapper } = buildDropdown();
  sendButton.parentElement?.insertAdjacentElement('beforebegin', wrapper);
}

function injectIntoLeftActions(leftActions: HTMLElement) {
  if (hasAiBtnInSameComposer(leftActions)) return;

  const { wrapper } = buildDropdown();
  // Prefer injecting as sibling to avoid messing with LinkedIn layout inside left-actions.
  leftActions.insertAdjacentElement('afterend', wrapper);
}

function findRightActionsAllVisible(root: ParentNode = document): HTMLElement[] {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>('.msg-form__right-actions'),
  );
  if (candidates.length === 0) return [];
  return candidates.filter((el) => el.offsetParent !== null);
}

function getAllSearchRoots(): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = [document];
  const interopOutlet = document.querySelector<HTMLElement>('#interop-outlet');
  if (interopOutlet?.shadowRoot) {
    roots.push(interopOutlet.shadowRoot);
  }
  return roots;
}

export function injectAIGenerateButton() {
  const containers: HTMLElement[] = [];
  for (const root of getAllSearchRoots()) {
    const visibleInRoot = findRightActionsAllVisible(root);
    void root;
    containers.push(...visibleInRoot);
  }
  if (containers.length === 0) return;

  for (const rightActions of containers) {
    injectIntoRightActions(rightActions);
  }
}

let messagingObserverStarted = false;

export function observeMessagingForms() {
  if (messagingObserverStarted) return;
  messagingObserverStarted = true;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        // Right-actions (classic composer where Send lives here)
        if (node.classList.contains('msg-form__right-actions')) {
          injectIntoRightActions(node);
        } else {
          const containers = Array.from(
            node.querySelectorAll<HTMLElement>('.msg-form__right-actions'),
          );
          if (containers.length > 0) {
            containers.forEach(injectIntoRightActions);
          }
        }

        // Left-actions (new popup composer: footer.msg-form__footer with left-actions + send elsewhere)
        if (node.matches('footer.msg-form__footer')) {
          const left = node.querySelector<HTMLElement>('div.msg-form__left-actions');
          if (left) injectIntoLeftActions(left);
        } else {
          const footers = Array.from(node.querySelectorAll<HTMLElement>('footer.msg-form__footer'));
          for (const footer of footers) {
            const left = footer.querySelector<HTMLElement>('div.msg-form__left-actions');
            if (left) injectIntoLeftActions(left);
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

   // Fallback heartbeat: copre i casi in cui il container esiste già
   // ma viene popolato o mostrato in ritardo.
   setInterval(() => {
     const allContainers: HTMLElement[] = [];
     for (const root of getAllSearchRoots()) {
       const containers = Array.from(
         root.querySelectorAll<HTMLElement>('.msg-form__right-actions'),
       );
       void root;
       allContainers.push(...containers);
     }

     allContainers.forEach(injectIntoRightActions);

     // Also scan for the "footer composer" flavor and inject into left-actions.
     const allLeftActions: HTMLElement[] = [];
     for (const root of getAllSearchRoots()) {
       const footers = Array.from(root.querySelectorAll<HTMLElement>('footer.msg-form__footer'));
       for (const footer of footers) {
         const left = footer.querySelector<HTMLElement>('div.msg-form__left-actions');
         if (left) allLeftActions.push(left);
       }
     }
     allLeftActions.forEach(injectIntoLeftActions);
   }, 800);
}
