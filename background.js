// Lasker background service worker.
//
// Sole responsibility: forward toolbar-icon clicks to the active chess.com tab
// as a toggle message. All analysis and opening-theory data ships inside the
// extension, so no network access is needed from here.

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Lasker] Installed.");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "lasker:toggle" });
  } catch (_err) {
    // Content script not loaded on this page; nothing to do.
  }
});
