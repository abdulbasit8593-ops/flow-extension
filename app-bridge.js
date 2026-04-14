// ============================================================
// app-bridge.js — FlowPilot App Bridge
//
// The extension injects this file into the app page (localhost:3000).
// It creates a bridge so the app's JavaScript can talk to the extension.
//
// WHY WE NEED THIS:
// Normal web pages can't call chrome.runtime.sendMessage — that's
// only available to extension scripts. This bridge runs AS an
// extension script (content script) inside the app page, so it
// CAN call chrome.runtime. It listens for messages from the page
// via window.postMessage, forwards them to the extension, and
// posts the responses back.
//
// FLOW:
//   App JS → window.postMessage(FLOWPILOT_COMMAND)
//     → this bridge → chrome.runtime.sendMessage
//       → background.js → content.js in Flow tab
//         → response back → chrome.runtime callback
//           → window.postMessage(FLOWPILOT_RESPONSE)
//             → App JS promise resolves
// ============================================================

console.log("[FlowPilot Bridge] Loading...");

// ─────────────────────────────────────────────────────────────
// STEP 1: Tell the app page the bridge is ready.
// Post READY every 400ms until the page sends back an ACK.
// This fixes the race condition where the page isn't listening yet.
// ─────────────────────────────────────────────────────────────
let ackReceived = false;

function announceReady() {
  window.postMessage({ type: "FP_READY" }, "*");
}

// Post immediately, then every 400ms
announceReady();
const readyTimer = setInterval(() => {
  if (ackReceived) {
    clearInterval(readyTimer);
    return;
  }
  announceReady();
}, 400);

// ─────────────────────────────────────────────────────────────
// STEP 2: Listen for messages from the app page
// ─────────────────────────────────────────────────────────────
window.addEventListener("message", (event) => {
  // Safety check: only handle messages from this same page
  if (event.source !== window) return;

  const msg = event.data;
  if (!msg || !msg.type) return;

  // ── App page acknowledged our READY signal ──
  if (msg.type === "FP_ACK") {
    ackReceived = true;
    console.log("[FlowPilot Bridge] Page acknowledged. Bridge is live.");
    // Tell the app we're confirmed ready
    window.postMessage({ type: "FP_CONFIRMED" }, "*");
    return;
  }

  // ── App page sent a command to forward to the extension ──
  if (msg.type === "FP_COMMAND") {
    const { reqId, command, payload } = msg;
    console.log(`[FlowPilot Bridge] → ${command}`, payload || "");

    // Forward to background.js via chrome.runtime
    chrome.runtime.sendMessage({ command, payload: payload || {} }, (response) => {

      // Check for Chrome extension errors (e.g. no listener)
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message;
        console.error(`[FlowPilot Bridge] Chrome error for ${command}: ${errMsg}`);
        window.postMessage({
          type: "FP_RESPONSE",
          reqId,
          ok: false,
          error: `Extension error: ${errMsg}`,
        }, "*");
        return;
      }

      // Handle missing response
      if (!response) {
        console.error(`[FlowPilot Bridge] No response for ${command}`);
        window.postMessage({
          type: "FP_RESPONSE",
          reqId,
          ok: false,
          error: `No response received. Make sure Google Flow is open in another tab.`,
        }, "*");
        return;
      }

      console.log(`[FlowPilot Bridge] ← ${command} ok=${response.ok}`, response.error || "");

      // Send response back to app page
      window.postMessage({
        type: "FP_RESPONSE",
        reqId,
        ok: response.ok,
        error: response.error || null,
        data: response.data || null,
      }, "*");
    });
  }
});

// ─────────────────────────────────────────────────────────────
// STEP 3: Forward extension events to the app page
// Events like FLOW_STATE_CHANGED come from background.js
// ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.event) {
    window.postMessage({ type: "FP_EVENT", event: message.event, data: message.data }, "*");
  }
});

console.log("[FlowPilot Bridge] Ready. Waiting for page ACK...");
