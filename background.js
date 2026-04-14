// ============================================================
// background.js — FlowPilot Message Router
//
// This is the central hub. It sits between three things:
//   1. The APP PAGE (localhost:3000) — sends commands like SET_PROMPT
//   2. The POPUP — sends the same kinds of commands
//   3. The FLOW TAB — runs content.js which actually touches the DOM
//
// THE KEY FIX:
// The app page is a Chrome tab, so sender.tab exists for its messages.
// We tell the difference from content.js messages by checking the URL:
//   - content.js runs on labs.google → sender.tab.url contains labs.google
//   - app page runs on localhost → sender.tab.url contains localhost
//
// MESSAGE FLOW:
//   App/Popup → background.js → content.js (in Flow tab) → DOM action → response
//   content.js event → background.js → app page + popup (broadcast)
// ============================================================

importScripts("logger.js");

// ─────────────────────────────────────────────────────────────
// MAIN MESSAGE LISTENER
// Handles all messages coming into the background service worker
// ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Case 1: Message from the Flow tab's content script ───────
  // content.js sends events like FLOW_STATE_CHANGED
  // We broadcast these to the popup and app page so they can update their UI
  if (sender.tab && sender.tab.url && sender.tab.url.includes("labs.google")) {
    log.info("background", `Event from Flow tab: ${message.event || message.command}`);
    // Broadcast to all extension views (popup, etc.)
    chrome.runtime.sendMessage(message).catch(() => {
      // Popup might be closed — that's fine, ignore the error
    });
    sendResponse({ ok: true });
    return true; // keep channel open
  }

  // ── Case 2: Message from the app page (localhost) ────────────
  // The app page sends commands like SET_PROMPT, CLICK_GENERATE
  // We forward these to the Flow tab's content.js
  if (sender.tab && sender.tab.url && sender.tab.url.includes("localhost")) {
    log.info("background", `Command from app page: ${message.command}`);
    forwardToFlowTab(message, sendResponse);
    return true; // keep channel open for async
  }

  // ── Case 3: Message from the popup ───────────────────────────
  // Popup has no sender.tab (it's an extension view, not a tab)
  if (!sender.tab) {
    log.info("background", `Command from popup: ${message.command}`);
    forwardToFlowTab(message, sendResponse);
    return true; // keep channel open for async
  }

  // ── Fallback: unknown source ──────────────────────────────────
  log.warn("background", `Unknown message source: ${sender.tab?.url || "no-tab"}`);
  sendResponse({ ok: false, error: "Unknown message source" });
  return true;
});

// ─────────────────────────────────────────────────────────────
// FORWARD TO FLOW TAB
// Finds the Google Flow tab and sends the command to content.js
// ─────────────────────────────────────────────────────────────
async function forwardToFlowTab(message, sendResponse) {
  try {
    // Find any open tab on labs.google (the Flow editor)
    const tabs = await chrome.tabs.query({ url: "https://labs.google/*" });

    if (!tabs || tabs.length === 0) {
      const err = "No Google Flow tab found. Open labs.google/flow in Chrome first.";
      log.error("background", err);
      sendResponse({ ok: false, error: err });
      return;
    }

    // Use the first Flow tab found (prefer active one)
    const flowTab = tabs.find(t => t.active) || tabs[0];
    log.info("background", `Forwarding '${message.command}' to tab ${flowTab.id}`);

    // Send to content.js running in that tab
    const response = await chrome.tabs.sendMessage(flowTab.id, message);

    log.info("background", `Response for '${message.command}':`, { ok: response?.ok, error: response?.error });
    sendResponse(response);

  } catch (err) {
    const errMsg = err?.message || String(err);
    log.error("background", `Failed to forward '${message.command}': ${errMsg}`);
    sendResponse({ ok: false, error: errMsg });
  }
}

// ─────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────
log.info("background", "FlowPilot background service worker started");
