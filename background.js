// ChessMate background service worker.
//
// Two jobs:
//   1. Toolbar icon click -> toggle analysis in the active chess.com tab.
//   2. Proxy Lichess Opening Explorer fetches. Content scripts run in the
//      chess.com origin which Lichess sometimes 401s; fetching from the
//      extension origin (via host_permissions) works reliably.

const LICHESS_ENDPOINT = "https://explorer.lichess.ovh/masters";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[ChessMate] Installed.");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "chessmate:toggle" });
  } catch (_err) {
    // Content script not loaded on this page; nothing to do.
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "chessmate:opening" && typeof msg.fen === "string") {
    fetchOpening(msg.fen).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: String(err && err.message || err) })
    );
    return true;
  }
  return false;
});

async function fetchOpening(fen) {
  const url = `${LICHESS_ENDPOINT}?fen=${encodeURIComponent(fen)}&moves=5&topGames=0`;
  const resp = await fetch(url, {
    method: "GET",
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) return null;
  return await resp.json();
}
