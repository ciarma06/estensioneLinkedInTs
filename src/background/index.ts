// src/background/index.ts

const LINKEDIN_ORIGIN = 'https://www.linkedin.com';
let sidePanelPort: chrome.runtime.Port | null = null;

chrome.sidePanel.setOptions({ enabled: false });

const togglePanelContext = async (tabId: number, url?: string) => {
  if (url?.startsWith(LINKEDIN_ORIGIN)) {
    await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
  } else {
    await chrome.sidePanel.setOptions({ tabId, enabled: false });
  }
};

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  togglePanelContext(activeInfo.tabId, tab.url);
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  togglePanelContext(tabId, tab.url);
});

// ─────────────────────────────────────────────
// SPA NAVIGATION: manda segnale al content script
// ─────────────────────────────────────────────
let lastUrl = '';
let navTimer: ReturnType<typeof setTimeout> | null = null;

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (!details.url.includes('linkedin.com')) return;
  if (details.url === lastUrl) return;
  lastUrl = details.url;

  console.log('🗺️ SPA navigation:', details.url);

  if (navTimer) clearTimeout(navTimer);
  navTimer = setTimeout(() => {
    chrome.tabs.sendMessage(details.tabId, { action: 'spa_navigation' })
      .catch(() => {});
  }, 300);
}, { url: [{ hostContains: 'linkedin.com' }] });

// ─────────────────────────────────────────────
// MESSAGGI: side panel
// ─────────────────────────────────────────────
const CRM_PANEL_STORAGE_KEY = 'ln_crm_panel_open';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'crm_sidepanel') return;

  sidePanelPort = port;
  void chrome.storage.local.set({ [CRM_PANEL_STORAGE_KEY]: true });

  port.onDisconnect.addListener(() => {
    sidePanelPort = null;
    void chrome.storage.local.set({ [CRM_PANEL_STORAGE_KEY]: false });
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.action === 'toggle_side_panel') {
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    if (tabId && windowId) {
      if (sidePanelPort) {
        try {
          sidePanelPort.postMessage({ action: 'close_panel' });
        } catch (e) {
          console.error(e);
        }
      } else {
        chrome.sidePanel.open({ tabId, windowId }).catch(console.error);
      }
    }
  }

  if (message.action === 'open_side_panel') {
    // Open only if not already open; if it's open, do nothing.
    if (sidePanelPort) return;
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    if (tabId && windowId) {
      chrome.sidePanel.open({ tabId, windowId }).catch(console.error);
    }
  }
});

console.log('Background worker started 🚀');



export {};