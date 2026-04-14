// ============================================================
// content.js — FlowPilot Content Script
// Injected into: https://labs.google/*
// Responsibility: Touch the actual Google Flow DOM
// ============================================================

// ---- Inline logger (content scripts can't importScripts) ---
const LogLevel = { INFO: "INFO", SUCCESS: "SUCCESS", WARN: "WARN", ERROR: "ERROR" };
const LOG_KEY = "flowpilot_logs";
const MAX_LOGS = 200;

async function writeLog(level, source, message, data = null) {
  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    data: data ? (() => { try { return JSON.stringify(data, Object.getOwnPropertyNames(data)); } catch { return String(data); } })() : null,
  };

  const colors = { INFO: "color:#60a5fa", SUCCESS: "color:#4ade80", WARN: "color:#facc15", ERROR: "color:#f87171" };
  console.log(`%c[FlowPilot][${level}][${source}] ${message}`, colors[level] || "", data || "");

  try {
    const result = await chrome.storage.local.get(LOG_KEY);
    const logs = result[LOG_KEY] || [];
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await chrome.storage.local.set({ [LOG_KEY]: logs });
  } catch (err) {
    console.error("[FlowPilot][Logger] Failed to persist log:", err);
  }
  return entry;
}

const log = {
  info:    (msg, data) => writeLog(LogLevel.INFO,    "content", msg, data),
  success: (msg, data) => writeLog(LogLevel.SUCCESS, "content", msg, data),
  warn:    (msg, data) => writeLog(LogLevel.WARN,    "content", msg, data),
  error:   (msg, data) => writeLog(LogLevel.ERROR,   "content", msg, data),
};


// ============================================================
// SELECTORS
// Based on actual HTML provided from the live Flow UI.
// These are ranked: most specific first, fallbacks after.
// If Flow updates their UI, start here to fix things.
// ============================================================

const SELECTORS = {

  // The "Start" frame button (left side of the swap row)
  // It's a div with type="button" and text content "Start"
  START_FRAME_BUTTON: [
    'div[aria-haspopup="dialog"][data-state="closed"].sc-5496b68c-1',
    'div[aria-haspopup="dialog"]',
  ],

  // The main prompt contenteditable div (Slate editor)
  PROMPT_BOX: [
    'div[role="textbox"][contenteditable="true"][data-slate-editor="true"]',
    'div[contenteditable="true"][data-slate-editor="true"]',
    'div[role="textbox"][contenteditable="true"]',
  ],

  // The settings/mode button (shows "Video x4" etc.)
  SETTINGS_BUTTON: [
    'button[aria-haspopup="menu"][data-state="closed"].sc-46973129-1',
    'button[aria-haspopup="menu"]',
  ],

  // The generate/create button (has aria span "Create" inside)
  GENERATE_BUTTON: [
    // Most reliable: button containing a span with exact text "Create"
    // We find this in JS since CSS can't filter by child text easily
    'button.sc-74ba1bc0-4',
    'button span:contains("Create")', // jQuery-style, we handle in JS
  ],

  // Number of videos selector buttons (x1, x2, x3, x4)
  COUNT_BUTTONS: [
    'button', // broad, we filter by text in JS
  ],
};


// ============================================================
// DOM HELPERS
// ============================================================

/**
 * Try a list of CSS selectors, return the first match.
 */
function queryAny(selectors, root = document) {
  for (const sel of selectors) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch (e) { /* invalid selector, skip */ }
  }
  return null;
}

/**
 * Wait for an element to appear in the DOM.
 */
function waitForElement(selectors, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const el = queryAny(selectors);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const found = queryAny(selectors);
      if (found) { observer.disconnect(); resolve(found); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for: ${selectors.join(", ")}`));
    }, timeoutMs);
  });
}

/**
 * Small delay helper.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- React / Radix UI click helper -----------------------

/**
 * radixClick — The correct way to trigger Radix UI components.
 *
 * Radix UI (used by Google Flow for dropdowns/dialogs) listens to POINTER events,
 * not mouse events or React synthetic onClick. Specifically it needs:
 *   pointerdown → pointerup → click
 * all with { bubbles: true, isPrimary: true }.
 *
 * Standard MouseEvent, React props onClick, and execCommand all fail here.
 * This is the only reliable method for Radix components.
 */
function radixClick(el) {
  const opts = { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 };
  el.dispatchEvent(new PointerEvent("pointerover",  opts));
  el.dispatchEvent(new PointerEvent("pointerenter", opts));
  el.dispatchEvent(new PointerEvent("pointerdown",  opts));
  el.dispatchEvent(new MouseEvent("mousedown",      { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new PointerEvent("pointerup",    opts));
  el.dispatchEvent(new MouseEvent("mouseup",        { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("click",          { bubbles: true, cancelable: true, button: 0 }));
}

/**
 * simulateClick — use radixClick as the universal strategy.
 */
function simulateClick(el) {
  radixClick(el);
}

// ---- Slate editor helper ---------------------------------

/**
 * setSlateText — reliably set text in a Slate.js contenteditable editor.
 *
 * WHY THIS IS HARD:
 * Slate.js maintains its own virtual document model. It ignores direct DOM writes.
 * The only inputs Slate reliably responds to are:
 *   1. beforeinput events with inputType="insertText" (the modern standard)
 *   2. Real clipboard paste events with proper DataTransfer
 *
 * APPROACH — two-stage:
 *   Stage 1: Clear existing content using Ctrl+A + Delete via beforeinput
 *   Stage 2: Insert new text via InputEvent with inputType="insertText"
 *
 * This matches exactly what browsers send during real typing, which is what
 * Slate's event handlers are written to consume.
 *
 * The DOM structure when text is present (from live HTML inspection):
 *   <p data-slate-node="element">
 *     <span data-slate-node="text">
 *       <span data-slate-leaf="true">
 *         <span data-slate-string="true">YOUR TEXT HERE</span>
 *       </span>
 *     </span>
 *   </p>
 *
 * The DOM structure when EMPTY:
 *   Same but with data-slate-placeholder="true" span and data-slate-zero-width span.
 *   The placeholder disappears only when Slate's internal model has content.
 */
async function setSlateText(editorEl, text) {
  // ---- Stage 0: Focus & establish a cursor position ----
  editorEl.focus();
  await sleep(100);

  // Place the text cursor inside the editor via Selection API
  // Slate needs a real browser selection to know where to insert
  const selection = window.getSelection();
  const range = document.createRange();
  // Select all content inside the editor
  range.selectNodeContents(editorEl);
  selection.removeAllRanges();
  selection.addRange(range);
  await sleep(60);

  // ---- Stage 1: Clear existing content ----
  // Fire a beforeinput with inputType "deleteContent" — Slate handles this
  editorEl.dispatchEvent(new InputEvent("beforeinput", {
    inputType: "deleteContentBackward",
    bubbles: true,
    cancelable: true,
  }));
  await sleep(40);

  // Also try select-all + delete via keyboard for belt-and-suspenders
  editorEl.dispatchEvent(new KeyboardEvent("keydown", {
    key: "a", code: "KeyA", ctrlKey: true, metaKey: false,
    bubbles: true, cancelable: true
  }));
  await sleep(40);
  editorEl.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Delete", code: "Delete", bubbles: true, cancelable: true
  }));
  await sleep(40);

  // ---- Stage 2: Insert new text via beforeinput insertText ----
  // This is the event Slate's onDOMBeforeInput handler is specifically watching for.
  // It's fired by browsers before every real keystroke — we're mimicking that.
  editorEl.dispatchEvent(new InputEvent("beforeinput", {
    inputType: "insertText",
    data: text,
    bubbles: true,
    cancelable: true,
  }));
  await sleep(80);

  // ---- Stage 3: Check if it worked ----
  let resultText = getSlateText(editorEl);

  if (resultText.length > 2) {
    return resultText; // Success — Slate model updated
  }

  // ---- Stage 4: Fallback — clipboard paste ----
  // Some Slate versions respond better to paste than beforeinput
  await log.warn("beforeinput method produced no result — trying clipboard paste fallback");
  editorEl.focus();
  await sleep(60);

  // Re-select all
  const sel2 = window.getSelection();
  const range2 = document.createRange();
  range2.selectNodeContents(editorEl);
  sel2.removeAllRanges();
  sel2.addRange(range2);
  await sleep(40);

  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    editorEl.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    }));
    await sleep(100);
  } catch (e) {
    await log.warn("ClipboardEvent paste also failed", e);
  }

  resultText = getSlateText(editorEl);
  if (resultText.length > 2) return resultText;

  // ---- Stage 5: Last resort — execCommand insertText ----
  // Works in Chrome extensions even though it's deprecated
  await log.warn("Paste fallback produced no result — trying execCommand last resort");
  editorEl.focus();
  await sleep(40);
  document.execCommand("selectAll", false, null);
  await sleep(30);
  document.execCommand("insertText", false, text);
  await sleep(80);

  return getSlateText(editorEl);
}

/**
 * Read the actual text content from the Slate editor's DOM.
 * Looks for data-slate-string="true" spans (present when Slate has real content).
 * Falls back to textContent minus placeholder text.
 */
function getSlateText(editorEl) {
  // Best method: find the actual text spans Slate renders when content exists
  const stringSpans = editorEl.querySelectorAll('[data-slate-string="true"]');
  if (stringSpans.length > 0) {
    return Array.from(stringSpans).map(s => s.textContent).join("").trim();
  }

  // Fallback: get all text but strip out the placeholder text
  const placeholder = editorEl.querySelector('[data-slate-placeholder="true"]');
  const placeholderText = placeholder?.textContent || "";
  const fullText = editorEl.textContent || "";
  return fullText.replace(placeholderText, "").trim();
}

// ---- Element finders --------------------------------------

/**
 * Find the main generate/create button.
 * Has class sc-74ba1bc0-4, OR contains a "Create" span but NOT aria-haspopup="dialog"
 * (the ingredients Add button also has a "Create" span but does have aria-haspopup="dialog").
 */
function findGenerateButton() {
  const byClass = document.querySelector('button.sc-74ba1bc0-4');
  if (byClass) return byClass;

  const buttons = document.querySelectorAll("button");
  for (const btn of buttons) {
    if (btn.getAttribute("aria-haspopup") === "dialog") continue;
    for (const span of btn.querySelectorAll("span")) {
      if (span.textContent.trim() === "Create") return btn;
    }
  }
  return null;
}

/**
 * Find the Start frame button (div with aria-haspopup="dialog" and text "Start")
 */
function findStartFrameButton() {
  const candidates = document.querySelectorAll('div[aria-haspopup="dialog"]');
  for (const el of candidates) {
    if (el.textContent.trim() === "Start") return el;
  }
  return null;
}

/**
 * Find the End frame button (div with aria-haspopup="dialog" and text "End")
 */
function findEndFrameButton() {
  const candidates = document.querySelectorAll('div[aria-haspopup="dialog"]');
  for (const el of candidates) {
    if (el.textContent.trim() === "End") return el;
  }
  return null;
}

/**
 * Find the Ingredients "Add" button.
 * It's a button[aria-haspopup="dialog"] containing <i> with text "add_2".
 */
function findIngredientsAddButton() {
  const candidates = document.querySelectorAll('button[aria-haspopup="dialog"]');
  for (const btn of candidates) {
    for (const icon of btn.querySelectorAll("i")) {
      if (icon.textContent.trim() === "add_2") return btn;
    }
  }
  return null;
}

/**
 * Find the remove/clear button for a frame thumbnail.
 *
 * When a frame is set, Flow shows a thumbnail with an X/delete button overlaid on it.
 * The delete button is typically a button inside the frame thumbnail container
 * that contains a "close", "delete", or "cancel" material icon.
 * We look inside the frame row container (.sc-5496b68c-0) for such a button.
 *
 * @param {"start"|"end"} which - which frame's remove button to find
 */
function findFrameRemoveButton(which) {
  const frameRow = document.querySelector('.sc-5496b68c-0');
  if (!frameRow) return null;

  // The frame row has two slots: [0] = start frame area, [1] = end frame area
  // Each slot is a container that holds either the placeholder div OR a thumbnail
  // The thumbnail has a remove/close button overlaid
  const slots = frameRow.querySelectorAll('[class*="sc-"]');

  // Strategy: find buttons inside the frame row that contain a "close", "cancel",
  // or "delete" icon — these are the remove buttons on set thumbnails
  const removeIconNames = ["close", "cancel", "delete", "remove", "clear"];
  const allBtns = frameRow.querySelectorAll("button");

  // If looking for "start", take the first remove button; for "end", take the second
  const removeButtons = [];
  for (const btn of allBtns) {
    for (const icon of btn.querySelectorAll("i")) {
      if (removeIconNames.includes(icon.textContent.trim().toLowerCase())) {
        removeButtons.push(btn);
        break;
      }
    }
  }

  if (which === "start") return removeButtons[0] || null;
  if (which === "end")   return removeButtons[1] || removeButtons[0] || null;
  return null;
}

/**
 * Find the main settings button (the "Video x4" / "Image" pill at bottom-right).
 *
 * FIX: Old version matched on "Video" text — breaks in Image mode since the
 * button then shows "Image" or the model name.
 *
 * Reliable strategy: use the known CSS class sc-46973129-1 from captured HTML.
 * Fallback: find button[aria-haspopup="menu"] that is NOT nested inside an
 * already-open dropdown (i.e. not the model sub-dropdown).
 */
function findSettingsButton() {
  // Primary: use stable class from captured HTML
  const byClass = document.querySelector('button.sc-46973129-1[aria-haspopup="menu"]');
  if (byClass) return byClass;

  // Fallback: top-level menu button (not nested inside a radix content wrapper)
  const allMenuBtns = document.querySelectorAll('button[aria-haspopup="menu"]');
  for (const btn of allMenuBtns) {
    if (!btn.closest('[data-radix-menu-content]') &&
        !btn.closest('[data-radix-popper-content-wrapper]')) {
      return btn;
    }
  }
  return null;
}

/**
 * Read the actual current state of Flow's UI by inspecting the DOM.
 * Returns a complete picture of mode, subMode, and frame states.
 *
 * Frame detection logic:
 * - "Start" div present → start frame EMPTY (not yet set)
 * - "Start" div absent but we're in frames mode → start frame IS SET
 *   (Flow replaces the "Start" placeholder with a thumbnail image)
 * - Same logic for "End"
 *
 * subMode detection for image mode:
 * - Image mode never has Start/End frame divs
 * - If hasAddBtn in image mode → image mode is using "Ingredients" style
 * - Image mode carries its own subMode independent of video subMode
 */
function readFlowState() {
  const settingsBtn = findSettingsButton();
  if (!settingsBtn) {
    return { mode: null, subMode: null, settingsText: null };
  }

  // ── Mode detection: read ONLY direct TEXT_NODE children ──────
  // The button structure is: TEXT "Video" + <i>icon</i> + TEXT "x4" + <div>overlay</div>
  // We collect only text nodes (nodeType 3), skip everything else.
  // This avoids contamination from open dropdown child nodes.
  let settingsText = "";
  for (const node of settingsBtn.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      settingsText += node.textContent;
    }
    // Intentionally skip ALL element nodes — icons, overlay divs, and any open dropdown content
  }
  settingsText = settingsText.trim();

  // Video: direct text nodes contain "x1"–"x4" (e.g. "Video" + "x4")
  // Image: direct text nodes are model name only (e.g. "Nano Banana 2") — no count
  const mode = /x[1-4]/.test(settingsText) ? "video" : "image";

  const hasStartFrameBtn = !!findStartFrameButton();
  const hasEndFrameBtn   = !!findEndFrameButton();
  const hasAddBtn        = !!findIngredientsAddButton();
  const frameRowExists   = !!document.querySelector('.sc-5496b68c-0');
  const startFrameSet    = frameRowExists && !hasStartFrameBtn;
  const endFrameSet      = frameRowExists && !hasEndFrameBtn;

  let subMode = null;
  if (mode === "video") {
    if (frameRowExists) subMode = "frames";
    else if (hasAddBtn) subMode = "ingredients";
  } else {
    if (hasAddBtn) subMode = "ingredients";
  }

  return {
    mode,
    subMode,
    settingsText:    settingsText.trim().substring(0, 60),
    startFrameSet,
    endFrameSet,
    hasStartFrameBtn,
    hasEndFrameBtn,
    hasAddBtn,
    frameRowExists,
  };
}


// ============================================================
// COMMAND HANDLERS
// Each returns { ok: true, data? } or { ok: false, error: string }
// ============================================================

const commands = {

  // ---- PING: Check if content script is alive ----
  async PING() {
    await log.info("PING received — content script is alive");
    return { ok: true, data: "pong" };
  },

  // ---- GET_FLOW_STATE: Read actual Flow UI state (mode, subMode, etc.) ----
  // Used by popup on open to sync its display with reality.
  async GET_FLOW_STATE() {
    await log.info("Reading current Flow UI state");
    try {
      const state = readFlowState();
      await log.info("Flow state", state);
      return { ok: true, data: state };
    } catch (err) {
      await log.error("Error reading flow state", err);
      return { ok: false, error: err.message };
    }
  },

  // ---- CLICK_START_FRAME: Open the start frame dialog ----
  async CLICK_START_FRAME() {
    await log.info("Attempting to click Start Frame button");
    try {
      const btn = findStartFrameButton();
      if (!btn) {
        await log.error("Start Frame button not found — are you in Frames mode?");
        return { ok: false, error: "Start Frame button not found. Switch to Frames mode first." };
      }
      radixClick(btn);
      await log.success("Clicked Start Frame button");
      return { ok: true };
    } catch (err) {
      await log.error("Error clicking Start Frame button", err);
      return { ok: false, error: err.message };
    }
  },

  // ---- CLICK_END_FRAME: Open the end frame dialog ----
  async CLICK_END_FRAME() {
    await log.info("Attempting to click End Frame button");
    try {
      const btn = findEndFrameButton();
      if (!btn) {
        await log.error("End Frame button not found — are you in Frames mode?");
        return { ok: false, error: "End Frame button not found. Switch to Frames mode first." };
      }
      radixClick(btn);
      await log.success("Clicked End Frame button");
      return { ok: true };
    } catch (err) {
      await log.error("Error clicking End Frame button", err);
      return { ok: false, error: err.message };
    }
  },

  // ---- REMOVE_START_FRAME: Remove/clear the set start frame ----
  async REMOVE_START_FRAME() {
    await log.info("Attempting to remove Start Frame");
    try {
      const state = readFlowState();
      if (!state.startFrameSet) {
        await log.warn("Start frame is not set — nothing to remove");
        return { ok: false, error: "Start frame is not currently set." };
      }
      const btn = findFrameRemoveButton("start");
      if (!btn) {
        await log.error("Could not find Start Frame remove button", { state });
        return { ok: false, error: "Remove button for Start Frame not found. The frame thumbnail may use a different icon — inspect the frame area and report the HTML." };
      }
      radixClick(btn);
      await sleep(150);
      await log.success("Start Frame removed");
      return { ok: true };
    } catch (err) {
      await log.error("Error removing Start Frame", err);
      return { ok: false, error: err.message };
    }
  },

  // ---- REMOVE_END_FRAME: Remove/clear the set end frame ----
  async REMOVE_END_FRAME() {
    await log.info("Attempting to remove End Frame");
    try {
      const state = readFlowState();
      if (!state.endFrameSet) {
        await log.warn("End frame is not set — nothing to remove");
        return { ok: false, error: "End frame is not currently set." };
      }
      const btn = findFrameRemoveButton("end");
      if (!btn) {
        await log.error("Could not find End Frame remove button", { state });
        return { ok: false, error: "Remove button for End Frame not found. Inspect the frame thumbnail HTML and report back." };
      }
      radixClick(btn);
      await sleep(150);
      await log.success("End Frame removed");
      return { ok: true };
    } catch (err) {
      await log.error("Error removing End Frame", err);
      return { ok: false, error: err.message };
    }
  },

  // ---- CLICK_INGREDIENTS_ADD: Click the Add (+) button in Ingredients mode ----
  async CLICK_INGREDIENTS_ADD() {
    await log.info("Attempting to click Ingredients Add button");
    try {
      const btn = findIngredientsAddButton();
      if (!btn) {
        await log.error("Ingredients Add button not found — are you in Ingredients mode?");
        return { ok: false, error: "Ingredients Add button not found. Switch to Ingredients mode first." };
      }
      radixClick(btn);
      await log.success("Clicked Ingredients Add button");
      return { ok: true };
    } catch (err) {
      await log.error("Error clicking Ingredients Add button", err);
      return { ok: false, error: err.message };
    }
  },

  // ---- CLICK_SETTINGS: Open the mode/settings dropdown ----
  async CLICK_SETTINGS() {
    await log.info("Attempting to click Settings button");
    try {
      const btn = findSettingsButton();
      if (!btn) {
        await log.error("Could not find Settings button");
        return { ok: false, error: "Settings button not found. Are you on the Flow editor page?" };
      }

      const stateBefore = btn.getAttribute("data-state");
      await log.info("Settings button found", {
        text: btn.textContent.trim().substring(0, 30),
        dataState: stateBefore,
        ariaExpanded: btn.getAttribute("aria-expanded"),
        id: btn.id,
      });

      // Radix UI listens to PointerEvent (pointerdown specifically), not click/mousedown.
      // radixClick fires the full pointer event sequence Radix expects.
      radixClick(btn);
      await sleep(150);

      const stateAfter = btn.getAttribute("data-state");
      await log.info(`data-state after click: "${stateBefore}" → "${stateAfter}"`);

      if (stateAfter === "open") {
        await log.success("Settings dropdown opened");
        return { ok: true, data: { state: "open" } };
      }

      await log.error("Settings dropdown did not open", { stateBefore, stateAfter });
      return {
        ok: false,
        error: `Settings button clicked but data-state stayed "${stateAfter}" (expected "open"). The button HTML might have changed — run Get Page Info and check settingsBtnText.`,
      };

    } catch (err) {
      await log.error("Error clicking Settings button", err);
      return { ok: false, error: err.message };
    }
  },

  // ---- SET_PROMPT: Type text into Slate prompt box ----
  async SET_PROMPT({ text } = {}) {
    await log.info("Attempting to set prompt text", { textPreview: text?.substring(0, 80) });
    if (!text) {
      await log.warn("SET_PROMPT called with no text");
      return { ok: false, error: "No text provided for SET_PROMPT" };
    }

    try {
      const promptBox = queryAny(SELECTORS.PROMPT_BOX);
      if (!promptBox) {
        await log.error("Prompt box not found — is a Flow project open?");
        return { ok: false, error: "Prompt box not found. Open a Flow project first." };
      }

      await log.info("Prompt box found, using Slate beforeinput method");
      const resultText = await setSlateText(promptBox, text);

      // Verify using Slate-aware reader (checks data-slate-string spans)
      const verified = getSlateText(promptBox);
      await log.info("Post-set verification", { domResult: resultText, slateVerified: verified });

      if (!verified || verified.length < 2) {
        await log.error("Slate did not register the text after all attempts");
        return { ok: false, error: "Text was written to DOM but Slate's model did not update. Click manually in the Flow prompt box once, then retry SET_PROMPT." };
      }

      await log.success(`Prompt set (${verified.length} chars): "${verified.substring(0, 60)}"`);
      return { ok: true, data: { promptLength: verified.length, preview: verified.substring(0, 80) } };

    } catch (err) {
      await log.error("Error in SET_PROMPT", err);
      return { ok: false, error: err.message };
    }
  },

  // ---- CLICK_GENERATE: Click the arrow/create button ----
  async CLICK_GENERATE() {
    await log.info("Attempting to click Generate button");
    try {
      // Sanity-check: prompt must have content in Slate's model
      const promptBox = queryAny(SELECTORS.PROMPT_BOX);
      const slateText = promptBox ? getSlateText(promptBox) : "";
      if (!slateText) {
        await log.warn("Prompt box is empty — generation will be blocked by Flow");
        return { ok: false, error: "Prompt is empty. Use SET_PROMPT first." };
      }
      await log.info(`Prompt verified: "${slateText.substring(0, 60)}" (${slateText.length} chars)`);

      const btn = findGenerateButton();
      if (!btn) {
        await log.error("Generate button not found");
        return { ok: false, error: "Generate button (Create) not found." };
      }
      if (btn.disabled) {
        await log.warn("Generate button is disabled");
        return { ok: false, error: "Generate button is disabled — prompt may not have registered with Slate." };
      }

      // FIX: was calling reactClick (removed) — use radixClick
      radixClick(btn);
      await sleep(150);

      await log.success("Generate button clicked");
      return { ok: true };
    } catch (err) {
      await log.error("Error clicking Generate button", err);
      return { ok: false, error: err.message };
    }
  },

  // ---- READ_PROMPT: Return current Slate prompt text ----
  async READ_PROMPT() {
    await log.info("Reading current prompt text");
    try {
      const promptBox = queryAny(SELECTORS.PROMPT_BOX);
      if (!promptBox) return { ok: false, error: "Prompt box not found" };
      const text = getSlateText(promptBox);
      await log.info(`Current prompt: "${text.substring(0, 80)}"`);
      return { ok: true, data: { text } };
    } catch (err) {
      await log.error("Error reading prompt", err);
      return { ok: false, error: err.message };
    }
  },

  // ================================================================
  // SETTINGS MENU COMMANDS
  // ================================================================

  /**
   * Get the visible label of a tab button, stripping icon text.
   *
   * The tabs look like: <button><i class="google-symbols">videocam</i>Video</button>
   * textContent gives "videocamVideo" — we only want "Video".
   *
   * Fix: read only direct text nodes (nodeType === 3), ignore child elements.
   */
  _getTabLabel(tabEl) {
    let label = "";
    for (const node of tabEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        label += node.textContent;
      }
    }
    return label.trim();
  },

  /**
   * Helper: open settings dropdown, click a tab by its visible label, close.
   * Uses _getTabLabel to strip icon text from tab buttons.
   */
  async _clickSettingsTab({ tabLabel, logContext } = {}) {
    await log.info(`[${logContext}] Opening settings to click tab: "${tabLabel}"`);
    try {
      const settingsBtn = findSettingsButton();
      if (!settingsBtn) return { ok: false, error: "Settings button not found." };

      // Suppress the MutationObserver for 1.5s so it doesn't fight the
      // mode change the popup already knows about from runCommand()
      suppressNextStateChange(1500);

      // Open if not already open
      if (settingsBtn.getAttribute("data-state") !== "open") {
        radixClick(settingsBtn);
        await sleep(250);
        if (settingsBtn.getAttribute("data-state") !== "open") {
          return { ok: false, error: "Could not open settings dropdown." };
        }
        await log.info(`[${logContext}] Dropdown opened`);
      }

      // Find all tab buttons and match by stripped label
      const tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
      let target = null;
      const available = [];

      for (const tab of tabs) {
        const label = commands._getTabLabel(tab);
        available.push(label);
        if (label === tabLabel) { target = tab; break; }
      }

      if (!target) {
        await log.error(`[${logContext}] Tab "${tabLabel}" not found`, { available });
        radixClick(settingsBtn); // close before returning
        return { ok: false, error: `Tab "${tabLabel}" not found. Available: [${available.join(", ")}]` };
      }

      const wasActive = target.getAttribute("data-state") === "active";
      await log.info(`[${logContext}] Found tab "${tabLabel}", active=${wasActive}`);

      radixClick(target);
      await sleep(200);

      const isNowActive = target.getAttribute("data-state") === "active";

      // Close dropdown
      radixClick(settingsBtn);
      await sleep(100);

      if (isNowActive) {
        await log.success(`[${logContext}] "${tabLabel}" selected`);
        return { ok: true, data: { tab: tabLabel, wasAlreadyActive: wasActive } };
      }

      await log.error(`[${logContext}] Tab clicked but did not become active`);
      return { ok: false, error: `Tab "${tabLabel}" clicked but did not activate.` };

    } catch (err) {
      await log.error(`[${logContext}] Error`, err);
      return { ok: false, error: err.message };
    }
  },

  // ---- SET_MODE_VIDEO: Switch to Video generation mode ----
  async SET_MODE_VIDEO() {
    return commands._clickSettingsTab({ tabLabel: "Video", logContext: "SET_MODE_VIDEO" });
  },

  // ---- SET_MODE_IMAGE: Switch to Image generation mode ----
  async SET_MODE_IMAGE() {
    return commands._clickSettingsTab({ tabLabel: "Image", logContext: "SET_MODE_IMAGE" });
  },

  // ---- SET_VIDEO_MODE_FRAMES: Select Frames sub-mode (for avatar/image-to-video) ----
  async SET_VIDEO_MODE_FRAMES() {
    return commands._clickSettingsTab({ tabLabel: "Frames", logContext: "SET_VIDEO_MODE_FRAMES" });
  },

  // ---- SET_VIDEO_MODE_INGREDIENTS: Select Ingredients sub-mode ----
  async SET_VIDEO_MODE_INGREDIENTS() {
    return commands._clickSettingsTab({ tabLabel: "Ingredients", logContext: "SET_VIDEO_MODE_INGREDIENTS" });
  },

  // ---- SET_ASPECT_RATIO: Set aspect ratio by label ("9:16", "16:9", "4:3", "1:1", "3:4") ----
  async SET_ASPECT_RATIO({ ratio } = {}) {
    if (!ratio) return { ok: false, error: "No ratio provided. Use '9:16', '16:9', '4:3', '1:1', or '3:4'." };
    return commands._clickSettingsTab({ tabLabel: ratio, logContext: `SET_ASPECT_RATIO(${ratio})` });
  },

  // ---- SET_COUNT: Set number of videos to generate ("x1", "x2", "x3", "x4") ----
  async SET_COUNT({ count } = {}) {
    if (!count) return { ok: false, error: "No count provided. Use 'x1', 'x2', 'x3', or 'x4'." };
    const label = count.startsWith("x") ? count : `x${count}`; // accept "4" or "x4"
    return commands._clickSettingsTab({ tabLabel: label, logContext: `SET_COUNT(${label})` });
  },

  // ================================================================
  // MODEL SELECTION COMMANDS
  // The model dropdown is a separate nested dropdown inside the
  // settings menu. It's opened by a button showing the current model
  // name (e.g. "Veo 3.1 - Fast" or "🍌 Nano Banana 2").
  // ================================================================

  /**
   * Helper: open the model sub-dropdown and click a model by name.
   * Works for both video models (Veo) and image models (Nano Banana).
   *
   * @param {string} modelName - partial or full model name to match
   */
  async _selectModel({ modelName, logContext } = {}) {
    await log.info(`[${logContext}] Selecting model: "${modelName}"`);
    try {
      // First open settings if needed
      const settingsBtn = findSettingsButton();
      if (!settingsBtn) return { ok: false, error: "Settings button not found." };

      if (settingsBtn.getAttribute("data-state") !== "open") {
        radixClick(settingsBtn);
        await sleep(200);
      }

      // Find the model sub-dropdown button (has aria-haspopup="menu" inside the open dropdown)
      // There may be multiple — we find the one that's currently visible
      await sleep(100);
      const modelBtns = document.querySelectorAll('[data-radix-menu-content] button[aria-haspopup="menu"]');
      let modelDropdownBtn = null;
      if (modelBtns.length === 0) {
        // Fallback: any button with aria-haspopup="menu" that's not the main settings btn
        const allMenuBtns = document.querySelectorAll('button[aria-haspopup="menu"]');
        for (const b of allMenuBtns) {
          if (b !== settingsBtn) { modelDropdownBtn = b; break; }
        }
      } else {
        modelDropdownBtn = modelBtns[0];
      }

      if (!modelDropdownBtn) {
        await log.error(`[${logContext}] Model dropdown button not found`);
        return { ok: false, error: "Model dropdown button not found inside settings." };
      }

      await log.info(`[${logContext}] Model dropdown button found: "${modelDropdownBtn.textContent.trim().substring(0, 40)}"`);
      radixClick(modelDropdownBtn);
      await sleep(200);

      // Now find the model option by name (partial match)
      const menuItems = document.querySelectorAll('[role="menuitem"] .sc-a0dcecfb-8, [role="menuitem"] span');
      let targetItem = null;
      for (const item of menuItems) {
        if (item.textContent.trim().toLowerCase().includes(modelName.toLowerCase())) {
          // Click the parent button
          targetItem = item.closest('button') || item.closest('[role="menuitem"]');
          break;
        }
      }

      if (!targetItem) {
        const available = Array.from(menuItems).map(m => m.textContent.trim()).filter(Boolean);
        await log.error(`[${logContext}] Model "${modelName}" not found`, { available });
        return { ok: false, error: `Model "${modelName}" not found. Available: ${available.join(", ")}` };
      }

      radixClick(targetItem);
      await sleep(150);

      // Close settings
      if (settingsBtn.getAttribute("data-state") === "open") {
        radixClick(settingsBtn);
      }

      await log.success(`[${logContext}] Model "${modelName}" selected`);
      return { ok: true, data: { model: modelName } };

    } catch (err) {
      await log.error(`[${logContext}] Error`, err);
      return { ok: false, error: err.message };
    }
  },

  // ---- SELECT_VIDEO_MODEL: Pick a video model by name ----
  // modelName examples: "Veo 3.1 - Fast", "Veo 3.1 - Quality"
  async SELECT_VIDEO_MODEL({ modelName } = {}) {
    if (!modelName) return { ok: false, error: "No modelName provided." };
    return commands._selectModel({ modelName, logContext: `SELECT_VIDEO_MODEL` });
  },

  // ---- SELECT_IMAGE_MODEL: Pick an image model by name ----
  // modelName examples: "Nano Banana Pro", "Nano Banana 2", "Imagen 4"
  async SELECT_IMAGE_MODEL({ modelName } = {}) {
    if (!modelName) return { ok: false, error: "No modelName provided." };
    return commands._selectModel({ modelName, logContext: `SELECT_IMAGE_MODEL` });
  },

  // ---- GET_PAGE_INFO: Full snapshot of what's detected on page ----
  async GET_PAGE_INFO() {
    await log.info("Getting page info snapshot");
    try {
      const promptBox   = queryAny(SELECTORS.PROMPT_BOX);
      const generateBtn = findGenerateButton();
      const settingsBtn = findSettingsButton();
      const flowState   = readFlowState();
      const slateText   = promptBox ? getSlateText(promptBox) : null;

      const info = {
        url:                 window.location.href,
        isFlowProject:       window.location.href.includes("/flow/project/"),
        promptFound:         !!promptBox,
        promptSlateText:     slateText?.substring(0, 100) || "(empty)",
        promptHasContent:    (slateText?.length || 0) > 0,
        generateBtnFound:    !!generateBtn,
        generateBtnDisabled: generateBtn?.disabled || false,
        settingsBtnFound:    !!settingsBtn,
        settingsBtnText:     settingsBtn?.textContent?.trim()?.substring(0, 40) || null,
        ...flowState,
      };

      await log.info("Page info snapshot", info);
      return { ok: true, data: info };
    } catch (err) {
      await log.error("Error getting page info", err);
      return { ok: false, error: err.message };
    }
  },
};


// ============================================================
// MESSAGE LISTENER
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { command, payload } = message;

  if (!command) {
    sendResponse({ ok: false, error: "No command specified in message" });
    return true;
  }

  if (!commands[command]) {
    log.warn(`Unknown command received: ${command}`);
    sendResponse({ ok: false, error: `Unknown command: ${command}` });
    return true;
  }

  // Execute the command async
  commands[command](payload || {})
    .then((result) => sendResponse(result))
    .catch((err) => {
      log.error(`Unhandled error in command ${command}`, err);
      sendResponse({ ok: false, error: err.message || "Unknown error" });
    });

  return true; // Keep channel open for async
});

log.info("FlowPilot content script loaded on: " + window.location.href);

// ============================================================
// UI STATE WATCHER
// Observes Flow's DOM for changes (mode switch, frame set/removed)
// and pushes a FLOW_STATE_CHANGED message to the background,
// which forwards it to the popup so it can resync without
// the user needing to close and reopen the extension.
// ============================================================

let _lastStateJson = "";
let _ignoreNextStateChange = false;

/**
 * Call this from content.js commands right before they change the UI.
 * Prevents the observer from undoing the change the popup already knows about.
 */
function suppressNextStateChange(ms = 1500) {
  _ignoreNextStateChange = true;
  setTimeout(() => { _ignoreNextStateChange = false; }, ms);
}

function watchFlowState() {
  // Only watch the settings button itself — much narrower than watching all of document.body.
  // We re-locate it via a short poll since it may not exist immediately on load.
  let watchedBtn = null;
  let btnObserver = null;

  function attachToSettingsBtn() {
    const btn = findSettingsButton();
    if (!btn || btn === watchedBtn) return;

    // Detach from old button
    if (btnObserver) { btnObserver.disconnect(); btnObserver = null; }

    watchedBtn = btn;
    btnObserver = new MutationObserver(() => {
      if (_ignoreNextStateChange) return;

      // Only push state when dropdown is CLOSED (data-state = "closed")
      // This prevents the open-dropdown contamination issue entirely
      if (btn.getAttribute("data-state") !== "closed") return;

      clearTimeout(watchFlowState._timer);
      watchFlowState._timer = setTimeout(() => {
        try {
          const state = readFlowState();
          const stateJson = JSON.stringify(state);
          if (stateJson !== _lastStateJson) {
            _lastStateJson = stateJson;
            chrome.runtime.sendMessage({ event: "FLOW_STATE_CHANGED", data: state }).catch(() => {});
          }
        } catch (e) { /* silent */ }
      }, 400);
    });

    btnObserver.observe(btn, { attributes: true, attributeFilter: ["data-state", "class"] });
  }

  // Poll every 2s to pick up the button if page navigates or reloads
  attachToSettingsBtn();
  setInterval(attachToSettingsBtn, 2000);
}

watchFlowState();

