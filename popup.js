// ============================================================
// popup.js — FlowPilot
// Design principle: the popup owns its own UI state.
// After a successful command, the popup updates itself directly.
// GET_FLOW_STATE is only used once on open (initial sync).
// The MutationObserver in content.js is only for page reloads.
// ============================================================

const LOG_KEY = "flowpilot_logs";

// ── Current UI state ────────────────────────────────────────
// Single object — everything reads from here, everything writes here.
let UI = {
  mode:    "video",   // "video" | "image"
  subMode: "frames",  // "frames" | "ingredients" | null
  startFrameSet: false,
  endFrameSet:   false,
};

// ── Page tab switching ───────────────────────────────────────
document.querySelectorAll(".page-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".page-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("page-" + tab.dataset.page).classList.add("active");
    if (tab.dataset.page === "logs") loadLogs();
  });
});

// ── Command buttons ──────────────────────────────────────────
// All buttons with data-command are wired here.
// Buttons inside #frame-area are wired separately after render.
document.querySelectorAll("[data-command]").forEach(btn => {
  btn.addEventListener("click", () => handleBtnClick(btn));
});

function handleBtnClick(btn) {
  const command = btn.dataset.command;
  let payload = null;
  if (btn.dataset.payload) {
    try { payload = JSON.parse(btn.dataset.payload); } catch (e) {}
  }
  if (command === "SET_PROMPT") {
    const text = document.getElementById("promptInput").value.trim();
    if (!text) { setFooter("Type a prompt first"); return; }
    payload = { text };
  }
  runCommand(command, btn, payload);
}

// ── Core command runner ──────────────────────────────────────
async function runCommand(command, btnEl, payload = {}) {
  setBtnState(btnEl, "running");
  setDot("waiting");
  setFooter(`Running ${command}…`);

  let response;
  try {
    response = await chrome.runtime.sendMessage({ command, payload: payload || {} });
  } catch (err) {
    setBtnState(btnEl, "error");
    setDot("error");
    setFooter(`✗ ${err.message}`);
    setTimeout(() => setBtnState(btnEl, "idle"), 2500);
    return;
  }

  if (!response?.ok) {
    setBtnState(btnEl, "error");
    setDot("error");
    setFooter(`✗ ${(response?.error || "Unknown error").substring(0, 60)}`);
    setTimeout(() => setBtnState(btnEl, "idle"), 2500);
    return;
  }

  // ── Success ──────────────────────────────────────────────
  setBtnState(btnEl, "success");
  setDot("ok");
  setFooter(`✓ ${command}`);
  setTimeout(() => setBtnState(btnEl, "idle"), 2500);

  // Update UI state based on which command succeeded, then re-render.
  // We trust what we sent — no round-trip to Flow needed.
  switch (command) {
    case "SET_MODE_VIDEO":
      UI.mode = "video";
      UI.subMode = "frames"; // default subMode when entering video
      UI.startFrameSet = false;
      UI.endFrameSet   = false;
      break;
    case "SET_MODE_IMAGE":
      UI.mode = "image";
      UI.subMode = null;
      UI.startFrameSet = false;
      UI.endFrameSet   = false;
      break;
    case "SET_VIDEO_MODE_FRAMES":
      UI.mode = "video";
      UI.subMode = "frames";
      UI.startFrameSet = false;
      UI.endFrameSet   = false;
      break;
    case "SET_VIDEO_MODE_INGREDIENTS":
      UI.mode = "video";
      UI.subMode = "ingredients";
      break;
    case "REMOVE_START_FRAME":
      UI.startFrameSet = false;
      break;
    case "REMOVE_END_FRAME":
      UI.endFrameSet = false;
      break;
    case "CLICK_START_FRAME":
      // The frame dialog opens — we don't know yet if user picked something.
      // We'll rely on the observer to update once they close the dialog.
      break;
    case "CLICK_END_FRAME":
      break;
  }

  renderUI();

  if (document.querySelector('.page-tab[data-page="logs"]')?.classList.contains("active")) {
    loadLogs();
  }
}

// ── Render entire UI from UI state ───────────────────────────
// One function, called whenever UI changes. No scattered DOM writes elsewhere.
function renderUI() {
  // 1. Body class controls which CSS sections show (video-only / image-only)
  document.body.className = "mode-" + UI.mode;

  // 2. Mode tab highlights
  document.querySelectorAll('[data-command="SET_MODE_VIDEO"]')
    .forEach(b => b.classList.toggle("active", UI.mode === "video"));
  document.querySelectorAll('[data-command="SET_MODE_IMAGE"]')
    .forEach(b => b.classList.toggle("active", UI.mode === "image"));

  // 3. Sub-mode tab highlights (only relevant in video mode)
  document.querySelectorAll('[data-command="SET_VIDEO_MODE_FRAMES"]')
    .forEach(b => b.classList.toggle("active", UI.mode === "video" && UI.subMode === "frames"));
  document.querySelectorAll('[data-command="SET_VIDEO_MODE_INGREDIENTS"]')
    .forEach(b => b.classList.toggle("active", UI.mode === "video" && UI.subMode === "ingredients"));

  // 4. Frame area — rendered dynamically based on mode + subMode
  renderFrameArea();
}

// ── Frame area renderer ──────────────────────────────────────
function renderFrameArea() {
  const area = document.getElementById("frame-area");
  if (!area) return;

  // Determine what to show
  const showFrames      = UI.mode === "video" && UI.subMode === "frames";
  const showIngredients = UI.subMode === "ingredients"; // both video + image ingredients

  if (showFrames) {
    area.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px;">
        <div class="flow-tab-group">
          <button class="flow-tab${UI.startFrameSet ? " success" : ""}" data-command="CLICK_START_FRAME">
            🖼️ ${UI.startFrameSet ? "✓ Start Set" : "Set Start"}<div class="spinner"></div>
          </button>
          ${UI.startFrameSet
            ? `<button class="flow-tab error-state" data-command="REMOVE_START_FRAME" style="flex:0;padding:6px 10px;">✕<div class="spinner"></div></button>`
            : ""}
        </div>
        <div class="flow-tab-group">
          <button class="flow-tab${UI.endFrameSet ? " success" : ""}" data-command="CLICK_END_FRAME">
            🖼️ ${UI.endFrameSet ? "✓ End Set" : "Set End"}<div class="spinner"></div>
          </button>
          ${UI.endFrameSet
            ? `<button class="flow-tab error-state" data-command="REMOVE_END_FRAME" style="flex:0;padding:6px 10px;">✕<div class="spinner"></div></button>`
            : ""}
        </div>
      </div>`;

  } else if (showIngredients) {
    area.innerHTML = `
      <button class="action-btn" data-command="CLICK_INGREDIENTS_ADD">
        <span class="a-icon">➕</span>
        <span class="a-label">Add Ingredient<div class="a-desc">Opens the ingredient picker</div></span>
        <div class="spinner"></div>
      </button>`;

  } else {
    area.innerHTML = `<div style="font-size:10px;color:#3a3a3a;padding:4px 2px;">No frame controls in this mode.</div>`;
  }

  // Wire up buttons that were just rendered
  area.querySelectorAll("[data-command]").forEach(btn => {
    btn.addEventListener("click", () => handleBtnClick(btn));
  });
}

// ── Observer sync (page reload / external UI change only) ────
// Only fires when settings button closes after being open.
// Does NOT fire during our own command execution (suppressed by content.js).
chrome.runtime.onMessage.addListener((message) => {
  if (message.event !== "FLOW_STATE_CHANGED" || !message.data) return;
  const d = message.data;
  if (!d.mode) return;

  // Update UI state from observer data and re-render
  UI.mode          = d.mode;
  UI.subMode       = d.subMode || null;
  UI.startFrameSet = !!d.startFrameSet;
  UI.endFrameSet   = !!d.endFrameSet;
  renderUI();
});

// ── Helpers ──────────────────────────────────────────────────
function setBtnState(btn, state) {
  btn.classList.remove("running", "success", "error-state");
  if (state === "running") btn.classList.add("running");
  if (state === "success") btn.classList.add("success");
  if (state === "error")   btn.classList.add("error-state");
}

function setDot(state) {
  const dot = document.getElementById("dot");
  const txt = document.getElementById("statusText");
  dot.classList.remove("error", "waiting");
  if (state === "ok")      txt.textContent = "Flow tab found";
  if (state === "error")   { dot.classList.add("error");   txt.textContent = "Error"; }
  if (state === "waiting") { dot.classList.add("waiting"); txt.textContent = "Working…"; }
}

function setFooter(msg) {
  document.getElementById("footerMsg").textContent = msg;
}

// ── Logs ─────────────────────────────────────────────────────
async function loadLogs() {
  const result = await chrome.storage.local.get(LOG_KEY);
  const logs = (result[LOG_KEY] || []).slice().reverse();
  document.getElementById("logCount").textContent = `${logs.length} entries`;
  const list = document.getElementById("logList");
  if (!logs.length) { list.innerHTML = '<div class="log-empty">No logs yet.</div>'; return; }
  list.innerHTML = logs.map(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString("en-US", { hour12: false });
    const data = entry.data ? `<div class="log-data">${esc(entry.data)}</div>` : "";
    return `<div class="log-entry ${esc(entry.level)}">
      <div class="log-meta">
        <span class="log-badge">${esc(entry.level)}</span>
        <span class="log-src">${esc(entry.source || "")}</span>
        <span class="log-time">${time}</span>
      </div>
      <div class="log-msg">${esc(entry.message)}</div>${data}
    </div>`;
  }).join("");
}

function esc(s) {
  if (typeof s !== "string") return s ?? "";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

document.getElementById("clearLogsBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove(LOG_KEY);
  loadLogs();
});

// ── Init: sync with Flow on open ─────────────────────────────
(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: "https://labs.google/*" });
    if (!tabs.length) {
      document.getElementById("dot").classList.add("error");
      document.getElementById("statusText").textContent = "No Flow tab";
      setFooter("Open labs.google/flow first");
      renderUI(); // render default state
      return;
    }

    setDot("waiting");
    setFooter("Syncing…");

    const resp = await chrome.runtime.sendMessage({ command: "GET_FLOW_STATE", payload: {} });
    if (resp?.ok && resp.data?.mode) {
      UI.mode          = resp.data.mode;
      UI.subMode       = resp.data.subMode || null;
      UI.startFrameSet = !!resp.data.startFrameSet;
      UI.endFrameSet   = !!resp.data.endFrameSet;
      setFooter(`Synced: ${UI.mode}${UI.subMode ? " / " + UI.subMode : ""}`);
    } else {
      setFooter(`Flow tab found`);
    }

    setDot("ok");
  } catch (e) {
    setFooter("Ready");
  }

  renderUI(); // always render at the end of init
})();
