// src/moduli/crm.ts
import '../sidepanel.css';
import {
  getStoredAuth,
  requestOtp,
  verifyOtp,
  saveAuth,
  clearAuth,
  isAccessStillValid,
  type AuthState,
} from './authService';
import { apiListProfiles, apiDeleteProfile, apiUpdateProfile, fetchMessageQuota } from './apiClient';
import {
  LN_USER_TARGET_LANGUAGE_KEY,
  LN_USER_VALUE_PROP_KEY,
  LN_USER_AI_INSTRUCTIONS_KEY,
  TARGET_LANGUAGES,
} from './userSettings';

type SavedProfileRow = {
  id: number | string;
  full_name: string;
  linkedin_url: string;
  comment_text: string | null;
  comment_url: string | null;
  created_at?: string;
};

type ToastVariant = 'success' | 'error' | 'info';

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const truncate = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max)}…` : text);

let cachedProfiles: SavedProfileRow[] = [];
let currentQuery = '';

// ─── Quota indicator (AI messages) ───────────────────────────────────────────

/**
 * Stato della quota persistito in chrome.storage.local, in modo che il content
 * script di LinkedIn (messageGenerator) possa aggiornarlo dopo ogni generazione.
 * Il sidepanel ascolta storage.onChanged e ridisegna l'UI.
 */
export const QUOTA_STORAGE_KEY = 'linky_message_quota';

type StoredQuota = {
  used: number | null;
  limit: number | null;
  access: string;
  plan: 'assistant' | 'scout' | 'bundle' | null;
  checkedAt: number;
};

const isStoredQuota = (v: unknown): v is StoredQuota => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    (typeof o.used === 'number' || o.used === null) &&
    (typeof o.limit === 'number' || o.limit === null) &&
    typeof o.access === 'string'
  );
};

function renderQuotaIndicator(state: StoredQuota | null) {
  const wrap = document.getElementById('quota-indicator');
  const valueEl = document.getElementById('quota-value');
  const fillEl = document.getElementById('quota-fill');
  if (!wrap || !valueEl || !fillEl) return;

  if (!state) {
    wrap.hidden = true;
    return;
  }

  if (state.access === 'waitlist_trial') {
    wrap.hidden = false;
    wrap.classList.add('quota-indicator--trial');
    valueEl.textContent = 'Trial — 20/hour';
    valueEl.classList.remove('is-exhausted');
    valueEl.classList.add('is-trial');
    (fillEl as HTMLElement).style.width = '0%';
    fillEl.classList.remove('is-exhausted');
    return;
  }

  if (state.used === null || state.limit === null) {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  wrap.classList.remove('quota-indicator--trial');
  valueEl.classList.remove('is-trial');

  const used = Math.max(0, state.used);
  const limit = Math.max(0, state.limit);
  valueEl.textContent = `${used} / ${limit}`;

  const exhausted = limit > 0 && used >= limit;
  if (exhausted) {
    valueEl.classList.add('is-exhausted');
    fillEl.classList.add('is-exhausted');
  } else {
    valueEl.classList.remove('is-exhausted');
    fillEl.classList.remove('is-exhausted');
  }

  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  (fillEl as HTMLElement).style.width = `${pct}%`;
}

/**
 * Aggiorna il quota indicator e persiste lo stato in chrome.storage.local.
 * Esposta su window per uso da altri script in-process.
 */
function updateQuotaIndicator(
  used: number | null,
  limit: number | null,
  meta?: { access?: string; plan?: 'assistant' | 'scout' | 'bundle' | null },
) {
  const state: StoredQuota = {
    used,
    limit,
    access: meta?.access ?? (used === null && limit === null ? 'waitlist_trial' : 'premium'),
    plan: meta?.plan ?? null,
    checkedAt: Date.now(),
  };
  chrome.storage.local.set({ [QUOTA_STORAGE_KEY]: state }).catch(() => {
    // storage write failed; ignore
  });
  renderQuotaIndicator(state);
}

declare global {
  interface Window {
    updateQuotaIndicator?: typeof updateQuotaIndicator;
  }
}

if (typeof window !== 'undefined') {
  window.updateQuotaIndicator = updateQuotaIndicator;
}

async function refreshQuotaFromServer(jwt: string): Promise<void> {
  try {
    const q = await fetchMessageQuota(jwt);
    const state: StoredQuota = {
      used: q.messages_used,
      limit: q.messages_limit,
      access: q.access,
      plan: q.plan,
      checkedAt: Date.now(),
    };
    await chrome.storage.local.set({ [QUOTA_STORAGE_KEY]: state });
    renderQuotaIndicator(state);
  } catch (err) {
    console.error('[crm] fetchMessageQuota failed', err);
  }
}

const copyToClipboard = async (text: string) => {
  const value = String(text ?? '');
  if (!value) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall back below
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
};

const getSearchQuery = () => {
  const input = document.getElementById('crm-search-input') as HTMLInputElement | null;
  return (input?.value ?? '').trim();
};

const ensureSearchBar = () => {
  if (document.getElementById('crm-search')) return;

  const listContainer = document.getElementById('profiles-list');
  if (!listContainer) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'crm-search';
  wrapper.className = 'crm-search';
  wrapper.innerHTML = `
    <div class="crm-search__inner">
      <span class="crm-search__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" role="img" focusable="false">
          <path fill="currentColor" d="M10 2a8 8 0 105.293 14.293l4.707 4.707a1 1 0 001.414-1.414l-4.707-4.707A8 8 0 0010 2zm0 2a6 6 0 110 12 6 6 0 010-12z"></path>
        </svg>
      </span>
      <input id="crm-search-input" class="crm-search__input" type="text" placeholder="Search profiles…" autocomplete="off" />
      <button id="crm-search-clear" class="crm-search__clear" type="button" aria-label="Clear search">✕</button>
    </div>
  `;

  listContainer.insertAdjacentElement('beforebegin', wrapper);

  const input = wrapper.querySelector<HTMLInputElement>('#crm-search-input');
  const clearBtn = wrapper.querySelector<HTMLButtonElement>('#crm-search-clear');

  const update = () => {
    currentQuery = getSearchQuery();
    renderProfiles(cachedProfiles, currentQuery);
  };

  input?.addEventListener('input', update);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      (e.target as HTMLInputElement).value = '';
      update();
    }
  });

  clearBtn?.addEventListener('click', () => {
    if (input) input.value = '';
    update();
    input?.focus();
  });
};

const ensureToastContainer = () => {
  let container = document.getElementById('crm-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'crm-toast-container';
    document.body.appendChild(container);
  }
  return container;
};

const showToast = (message: string, variant: ToastVariant = 'success') => {
  const container = ensureToastContainer();

  const toast = document.createElement('div');
  toast.className = `crm-toast crm-toast--${variant}`;
  toast.textContent = message;

  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('is-visible');
  });

  const remove = () => {
    toast.classList.remove('is-visible');
    setTimeout(() => {
      toast.remove();
    }, 200);
  };

  toast.addEventListener('click', remove);
  setTimeout(remove, 2600);
};

const matchesQuery = (profile: SavedProfileRow, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (profile.full_name ?? '').toLowerCase().includes(q);
};

const renderProfiles = (rows: SavedProfileRow[], query: string) => {
  const listContainer = document.getElementById('profiles-list');
  if (!listContainer) return;

  const filtered = rows.filter((p) => matchesQuery(p, query));

  if (!filtered || filtered.length === 0) {
    listContainer.innerHTML = query
      ? `<p>No profiles found for "${escapeHtml(query)}".</p>`
      : '<p>You have not saved any profiles yet.</p>';
    return;
  }

  listContainer.innerHTML = filtered
    .map((profile) => {
      const id = profile.id;
      const fullName = escapeHtml(profile.full_name || 'Profile');
      const commentText = profile.comment_text ? truncate(profile.comment_text, 90) : '—';
      const linkedinUrl = escapeHtml(profile.linkedin_url || '#');
      const commentUrl = profile.comment_url ? escapeHtml(profile.comment_url) : null;

      return `
        <article class="crm-card" data-profile-id="${escapeHtml(id)}">
          <header class="crm-card__header">
            <div class="crm-card__title-group">
              <h3 class="crm-card__title" title="${fullName}">${fullName}</h3>
              <button class="crm-btn crm-btn--ghost crm-edit-btn" type="button" aria-label="Edit profile name">Edit</button>
            </div>
            <button class="crm-btn crm-btn--danger crm-delete-btn" type="button" aria-label="Delete profile">Delete</button>
          </header>

          <p class="crm-card__note">
            <span class="crm-card__note-text">📝 "${escapeHtml(commentText)}"</span>
            <button class="crm-btn crm-btn--icon crm-copy-comment-btn" type="button" aria-label="Copy full comment" title="Copy full comment">
              <svg viewBox="0 0 24 24" width="18" height="18" role="img" focusable="false" aria-hidden="true">
                <path fill="currentColor" d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16h-9V7h9v14z"></path>
              </svg>
            </button>
          </p>

          <div class="crm-card__actions">
            <a class="crm-link crm-link--primary" href="${linkedinUrl}" target="_blank" rel="noreferrer">👤 Profile</a>
            ${commentUrl ? `<a class="crm-link crm-link--success" href="${commentUrl}" target="_blank" rel="noreferrer">🔗 Open post</a>` : ''}
          </div>
        </article>
      `;
    })
    .join('');
};

// ─── Auth flow + app bootstrap ───────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const screens = {
    login: document.getElementById('screen-login')!,
    otp: document.getElementById('screen-otp')!,
    expired: document.getElementById('screen-expired')!,
    app: document.getElementById('app-main')!,
  };

  const show = (s: keyof typeof screens) => {
    (Object.keys(screens) as (keyof typeof screens)[]).forEach((k) => {
      screens[k].style.display = k === s ? 'block' : 'none';
    });
  };

  let pendingEmail = '';

  function handleAuthExpired() {
    clearAuth();
    console.warn('[auth] session expired, re-login required');
    window.location.reload();
  }

  function showExpiredScreen(access: string) {
    const msg = document.getElementById('expired-message')!;
    msg.textContent =
      access === 'expired_waitlist' || access === 'waitlist_trial'
        ? "Your 7-day trial has ended. Purchase full access to continue."
        : 'Your subscription has expired. Renew to keep using Linky Assistant.';
    const link = document.getElementById('purchase-link') as HTMLAnchorElement;
    link.href = import.meta.env.VITE_PURCHASE_URL as string;
    show('expired');
  }

  // Step 1: check stored auth
  const stored = await getStoredAuth();
  if (stored && isAccessStillValid(stored)) {
    show('app');
    initApp(stored);
    void refreshQuotaFromServer(stored.jwt);
    return;
  }

  if (stored && !isAccessStillValid(stored)) {
    await clearAuth();
    showExpiredScreen(stored.access);
    return;
  }

  // Step 2: email form
  document.getElementById('auth-email-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('auth-email-input') as HTMLInputElement;
    const errorEl = document.getElementById('auth-email-error')!;
    const btn = document.getElementById('auth-email-submit') as HTMLButtonElement;
    const email = input.value.trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorEl.textContent = 'Please enter a valid email address.';
      errorEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Sending…';
    errorEl.style.display = 'none';

    const result = await requestOtp(email);
    btn.disabled = false;
    btn.textContent = 'Send code';

    if (result.ok) {
      pendingEmail = email;
      show('otp');
    } else {
      errorEl.textContent = result.message;
      errorEl.style.display = 'block';
    }
  });

  // Step 3: OTP form
  document.getElementById('auth-otp-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('auth-otp-input') as HTMLInputElement;
    const errorEl = document.getElementById('auth-otp-error')!;
    const btn = document.getElementById('auth-otp-submit') as HTMLButtonElement;
    const code = input.value.trim();

    if (!/^\d{6}$/.test(code)) {
      errorEl.textContent = 'The code must be 6 digits.';
      errorEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Verifying…';
    errorEl.style.display = 'none';

    const result = await verifyOtp(pendingEmail, code);
    btn.disabled = false;
    btn.textContent = 'Verify';

    if ('jwt' in result) {
      await saveAuth(result);
      show('app');
      initApp(result);
      void refreshQuotaFromServer(result.jwt);
    } else if (result.access === 'expired_premium' || result.access === 'expired_waitlist') {
      showExpiredScreen(result.access);
    } else if (result.access === 'unauthorized') {
      errorEl.textContent = 'Unrecognised email or incorrect code.';
      errorEl.style.display = 'block';
    } else {
      errorEl.textContent = result.message || 'Connection error. Please try again.';
      errorEl.style.display = 'block';
    }
  });

  document.getElementById('auth-otp-back')!.addEventListener('click', () => {
    pendingEmail = '';
    show('login');
  });

  document.getElementById('expired-logout')!.addEventListener('click', async () => {
    await clearAuth();
    show('login');
  });

  show('login');

  // ─── Main app (called only after successful auth) ────────────────────────

  function initApp(_auth: AuthState) {
    // Quota indicator: render immediately from cache, then ascolta updates
    // scritti dal content script (messageGenerator) o da refreshQuotaFromServer.
    chrome.storage.local.get(QUOTA_STORAGE_KEY).then((r) => {
      const cached = r[QUOTA_STORAGE_KEY];
      if (isStoredQuota(cached)) renderQuotaIndicator(cached);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[QUOTA_STORAGE_KEY]) return;
      const next = changes[QUOTA_STORAGE_KEY].newValue;
      if (isStoredQuota(next)) renderQuotaIndicator(next);
      else if (next == null) renderQuotaIndicator(null);
    });

    const loadProfiles = async () => {
      ensureSearchBar();
      const listContainer = document.getElementById('profiles-list');
      if (!listContainer) return;

      listContainer.innerHTML = '<p>Loading profiles…</p>';

      const result = await apiListProfiles();

      if ('error' in result) {
        if (result.authExpired) {
          handleAuthExpired();
          return;
        }
        listContainer.innerHTML = `<p style="color: #6d47f5;">Database connection error: ${escapeHtml(result.error)}</p>`;
        return;
      }

      if (!result.profiles || result.profiles.length === 0) {
        cachedProfiles = [];
        renderProfiles([], getSearchQuery());
        return;
      }

      cachedProfiles = result.profiles as unknown as SavedProfileRow[];
      currentQuery = getSearchQuery();
      renderProfiles(cachedProfiles, currentQuery);
    };

    ensureSearchBar();
    loadProfiles();

    const valuePropTa = document.getElementById('ln-value-prop') as HTMLTextAreaElement | null;
    const aiInstructionsTa = document.getElementById('ln-ai-instructions') as HTMLTextAreaElement | null;
    const targetLanguageSelect = document.getElementById('ln-target-language') as HTMLSelectElement | null;
    const valuePropSave = document.getElementById('ln-value-prop-save');
    chrome.storage.local.get(
      [LN_USER_VALUE_PROP_KEY, LN_USER_TARGET_LANGUAGE_KEY, LN_USER_AI_INSTRUCTIONS_KEY],
      (r) => {
      if (valuePropTa) valuePropTa.value = String(r[LN_USER_VALUE_PROP_KEY] ?? '');
      if (aiInstructionsTa) aiInstructionsTa.value = String(r[LN_USER_AI_INSTRUCTIONS_KEY] ?? '');
      if (targetLanguageSelect) {
        const storedLanguage = String(r[LN_USER_TARGET_LANGUAGE_KEY] ?? '');
        targetLanguageSelect.value = TARGET_LANGUAGES.includes(storedLanguage as (typeof TARGET_LANGUAGES)[number])
          ? storedLanguage
          : 'Italiano';
      }
    });
    valuePropSave?.addEventListener('click', () => {
      if (!valuePropTa) return;
      const selectedLanguage =
        targetLanguageSelect && TARGET_LANGUAGES.includes(targetLanguageSelect.value as (typeof TARGET_LANGUAGES)[number])
          ? targetLanguageSelect.value
          : 'Italiano';
      chrome.storage.local.set(
        {
          [LN_USER_VALUE_PROP_KEY]: valuePropTa.value.trim(),
          [LN_USER_AI_INSTRUCTIONS_KEY]: aiInstructionsTa ? aiInstructionsTa.value.trim() : '',
          [LN_USER_TARGET_LANGUAGE_KEY]: selectedLanguage,
        },
        () => {
        showToast('Settings saved.', 'success');
        },
      );
    });

    // Refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        loadProfiles().then(() => {
          showToast('List refreshed.', 'info');
        });
      });
    }

    // Logout button
    const logoutBtn = document.getElementById('auth-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await clearAuth();
        window.location.reload();
      });
    }

    const listContainer = document.getElementById('profiles-list');
    if (listContainer) {
      listContainer.addEventListener('click', async (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;

        // DELETE
        const deleteBtn = target?.closest<HTMLButtonElement>('.crm-delete-btn');
        if (deleteBtn) {
          const card = deleteBtn.closest<HTMLElement>('.crm-card');
          const id = card?.dataset.profileId;
          if (!id) return;

          deleteBtn.disabled = true;
          deleteBtn.textContent = 'Deleting…';

          const result = await apiDeleteProfile(id);
          if ('error' in result) {
            if (result.authExpired) {
              handleAuthExpired();
              return;
            }
            showToast('Could not delete: ' + result.error, 'error');
            deleteBtn.disabled = false;
            deleteBtn.textContent = 'Delete';
            return;
          }

          await loadProfiles();
          showToast('Profile deleted.', 'success');
          return;
        }

        // ENTER EDIT MODE
        const editBtn = target.closest<HTMLButtonElement>('.crm-edit-btn');
        if (editBtn) {
          const card = editBtn.closest<HTMLElement>('.crm-card');
          if (!card) return;

          // If an editor is already open on this card, do not duplicate
          if (card.querySelector('.crm-name-edit')) {
            return;
          }

          const titleEl = card.querySelector<HTMLElement>('.crm-card__title');
          if (!titleEl) return;

          const currentName = titleEl.textContent?.trim() ?? '';

          const editor = document.createElement('div');
          editor.className = 'crm-name-edit';
          editor.innerHTML = `
            <input class="crm-name-edit__input" type="text" value="${escapeHtml(currentName)}" />
            <div class="crm-name-edit__actions">
              <button type="button" class="crm-btn crm-btn--primary crm-name-save">Save</button>
              <button type="button" class="crm-btn crm-name-cancel">Cancel</button>
            </div>
          `;

          titleEl.replaceWith(editor);

          const input = editor.querySelector<HTMLInputElement>('.crm-name-edit__input');
          if (input) {
            input.focus();
            input.select();
          }

          return;
        }

        // COPY FULL COMMENT
        const copyBtn = target.closest<HTMLButtonElement>('.crm-copy-comment-btn');
        if (copyBtn) {
          const card = copyBtn.closest<HTMLElement>('.crm-card');
          const id = card?.dataset.profileId;
          if (!id) return;

          const profile = cachedProfiles.find((p) => String(p.id) === String(id));
          const full = profile?.comment_text ?? '';
          const ok = await copyToClipboard(full);
          showToast(ok ? 'Comment copied.' : 'Could not copy comment.', ok ? 'success' : 'error');
          return;
        }

        // SAVE / CANCEL in the inline editor
        const card = target?.closest<HTMLElement>('.crm-card');
        if (!card) return;

        const editor = card.querySelector<HTMLElement>('.crm-name-edit');
        if (!editor) return;

        // SAVE
        const saveBtn = target.closest<HTMLButtonElement>('.crm-name-save');
        if (saveBtn) {
          const input = editor.querySelector<HTMLInputElement>('.crm-name-edit__input');
          if (!input) return;

          const newName = input.value.trim();
          if (!newName) {
            showToast('Name cannot be empty.', 'error');
            return;
          }

          const id = card.dataset.profileId;
          if (!id) return;

          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving…';

          const result = await apiUpdateProfile(id, newName);
          if ('error' in result) {
            if (result.authExpired) {
              handleAuthExpired();
              return;
            }
            showToast('Could not update: ' + result.error, 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
            return;
          }

          await loadProfiles();
          showToast('Profile name updated.', 'success');
          return;
        }

        // CANCEL
        const cancelBtn = target.closest<HTMLButtonElement>('.crm-name-cancel');
        if (cancelBtn) {
          await loadProfiles();
          return;
        }
      });
    }
  }
});


// Background connection (CRM open state + close from site toggle)
const crmSidePanelPort = chrome.runtime.connect({ name: 'crm_sidepanel' });
crmSidePanelPort.onMessage.addListener((message: { action?: string }) => {
  if (message.action === 'close_panel') {
    window.close();
  }
});
