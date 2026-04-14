# FlowPilot

Automate Google Flow video generation for avatar video workflows.

FlowPilot is two programs working together:

1. **The Chrome Extension** — a robot that controls the Google Flow website
2. **The App** — a web page where you manage your script and click Generate per line

They talk to each other through the browser. You never need to touch Google Flow directly.

---

## What It Does Right Now

- Upload a `.txt` or `.md` script file
- Paste your master prompt once (with `{{he_says}}` as a placeholder)
- The app splits your script into one block per line
- Each block shows the full prompt that will be sent to Flow
- Click **Generate** on any block → the extension types the prompt into Flow and clicks Generate for you

---

## Folder Structure

```
flowpilot-extension/
├── manifest.json        Chrome extension config — permissions, file list
├── background.js        The message router — sits between the app and Flow
├── content.js           The robot — injected into Google Flow, controls the UI
├── logger.js            Shared logging utility used by background.js
├── app-bridge.js        Injected into the app page — bridges app ↔ extension
├── popup.html           Extension popup UI (the small window when you click the icon)
├── popup.js             Popup logic
├── flowpilot-app.html   The main app page
├── server.js            Tiny Node.js server to serve the app at localhost:3000
└── icons/
    └── icon128.png
```

---

## How to Run

**Prerequisites:** Node.js installed, Chrome browser

**Step 1 — Install the extension**
1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `flowpilot-extension` folder

**Step 2 — Start the app server**
```
cd flowpilot-extension
node server.js
```

**Step 3 — Open the app**

Go to `http://localhost:3000` in Chrome. The activity log on the right will confirm the connection.

**Step 4 — Open Google Flow**

Open `labs.google/flow` in another Chrome tab. Set up your project settings manually (mode, model, aspect ratio etc). The extension will control Flow in that tab.

---

## How the Two Programs Talk

This is the most important thing to understand. Here's the full path a command takes:

```
App page (localhost:3000)
  ↓  window.postMessage("FP_COMMAND")
app-bridge.js  [content script injected into app page]
  ↓  chrome.runtime.sendMessage
background.js  [extension service worker — always running]
  ↓  chrome.tabs.sendMessage  →  Flow tab
content.js  [injected into labs.google tab]
  ↓  touches the actual DOM (clicks buttons, types text)
  ↑  returns { ok: true/false, data, error }
background.js
  ↑  sends response back
app-bridge.js
  ↑  window.postMessage("FP_RESPONSE")
App page  →  Promise resolves
```

**Why this path?** Normal web pages can't control browser tabs or other websites. Only extension scripts can do that. The bridge (`app-bridge.js`) is an extension script that runs inside the app page, giving it access to extension APIs.

---

## The Extension Files Explained

### `manifest.json`
Tells Chrome what the extension is allowed to do. Key entries:
- `host_permissions` — which websites the extension can inject into (`labs.google`, `localhost`)
- `content_scripts` — which JS files get injected into which pages automatically
- `background` — the service worker that runs in the background

### `background.js`
The message router. It receives all messages and decides where to send them.

**How it tells who sent a message:**
- `sender.tab.url` contains `labs.google` → message from `content.js` (an event) → broadcast to popup
- `sender.tab.url` contains `localhost` → message from the app page → forward to Flow tab
- No `sender.tab` → message from the popup → forward to Flow tab

This distinction is critical. Previously it was broken because the app page is also a "tab", so messages from it were being misidentified.

### `content.js`
The actual robot. Gets injected into `labs.google` tabs automatically.

Contains:
- **Element finders** — functions that locate specific buttons/inputs on the Flow page
- **`radixClick(el)`** — the correct way to click Radix UI components (Google Flow uses Radix UI, which needs `PointerEvent` not `MouseEvent`)
- **`setSlateText(el, text)`** — the correct way to type into the prompt box (Flow uses Slate.js which ignores regular DOM writes)
- **Command handlers** — one async function per command, each returns `{ ok, data, error }`
- **`readFlowState()`** — reads the current state of the Flow UI without changing anything
- **`watchFlowState()`** — a MutationObserver that detects when the user changes something in Flow directly and notifies the app

### `app-bridge.js`
A tiny relay injected into the app page. Converts between `window.postMessage` (what the app page can use) and `chrome.runtime.sendMessage` (what extension scripts can use).

It posts `FP_READY` every 400ms until the app page sends back `FP_ACK`. This prevents the race condition where the page loads before the bridge is injected.

### `logger.js`
Used by `background.js` (via `importScripts`). Writes logs to `chrome.storage.local` under the key `flowpilot_logs`. The extension popup shows these logs. Max 200 entries, oldest removed first.

---

## All Available Commands

These are the commands you can send from the app or popup. Each returns `{ ok: true/false, data?, error? }`.

### Diagnostic
| Command | What it does |
|---------|-------------|
| `PING` | Check content script is alive |
| `GET_PAGE_INFO` | Full snapshot of what's on the Flow page |
| `GET_FLOW_STATE` | Current mode, subMode, frame states — lighter than GET_PAGE_INFO |

### Prompt
| Command | Payload | What it does |
|---------|---------|-------------|
| `SET_PROMPT` | `{ text: "..." }` | Types text into the Flow prompt box |
| `READ_PROMPT` | — | Returns the current text in the prompt box |

### Settings
| Command | Payload | What it does |
|---------|---------|-------------|
| `SET_MODE_VIDEO` | — | Switch to Video mode |
| `SET_MODE_IMAGE` | — | Switch to Image mode |
| `SET_VIDEO_MODE_FRAMES` | — | Select Frames sub-mode |
| `SET_VIDEO_MODE_INGREDIENTS` | — | Select Ingredients sub-mode |
| `SET_ASPECT_RATIO` | `{ ratio: "9:16" }` | Set aspect ratio |
| `SET_COUNT` | `{ count: "x4" }` | Set number of outputs |
| `SELECT_VIDEO_MODEL` | `{ modelName: "Veo 3.1 - Fast" }` | Select video model |
| `SELECT_IMAGE_MODEL` | `{ modelName: "Nano Banana 2" }` | Select image model |

### Frames
| Command | What it does |
|---------|-------------|
| `CLICK_START_FRAME` | Open the Start Frame dialog |
| `CLICK_END_FRAME` | Open the End Frame dialog |
| `REMOVE_START_FRAME` | Remove the set Start Frame |
| `REMOVE_END_FRAME` | Remove the set End Frame |
| `CLICK_INGREDIENTS_ADD` | Click the Add button in Ingredients mode |

### Generation
| Command | What it does |
|---------|-------------|
| `CLICK_GENERATE` | Click the → Create button in Flow |

---

## How to Add a New Command

**3 steps, under 10 minutes:**

**1. Add a finder function in `content.js`** (in the "Element finders" section)
```js
function findMyButton() {
  // Try a specific selector first
  const el = document.querySelector('button.some-class');
  if (el) return el;
  // Fall back to searching by text or structure
  for (const btn of document.querySelectorAll('button')) {
    if (btn.textContent.includes('My Button')) return btn;
  }
  return null;
}
```

**2. Add the command handler in `content.js`** (in the `commands` object)
```js
async MY_COMMAND({ someParam } = {}) {
  await log.info("MY_COMMAND called", { someParam });
  try {
    const btn = findMyButton();
    if (!btn) return { ok: false, error: "Button not found" };
    radixClick(btn);
    await sleep(150); // give Flow time to react
    await log.success("MY_COMMAND done");
    return { ok: true };
  } catch (err) {
    await log.error("MY_COMMAND error", err);
    return { ok: false, error: err.message };
  }
}
```

**3. Call it from the app** (in `flowpilot-app.html`)
```js
const resp = await sendCommand("MY_COMMAND", { someParam: "value" });
if (!resp.ok) console.error(resp.error);
```

That's it. No other files need to change.

---

## What's Planned Next

### Video Downloads (not yet built)
After generation completes, the extension will:
1. Detect the 4 generated video tiles on the page
2. Download all 4 at 720p to local disk for instant preview
3. Let you pick which one you want
4. Download that one at 1080p and name it after the "he says" text

### AI Layer (future)
Because all actions go through `sendCommand()`, an AI agent can call the same function. Example:
```js
// Human does this:
await sendCommand("CLICK_GENERATE", {});

// AI agent does the exact same thing:
const action = await aiAgent.decide(projectState);
await sendCommand(action.command, action.payload);
```

No architectural changes needed — just add the AI decision layer on top.

---

## Troubleshooting

**"Extension not found" on the app page**
1. Make sure the extension is installed and enabled at `chrome://extensions`
2. Reload the extension (click the refresh icon)
3. Hard refresh the app page: `Ctrl+Shift+R`

**"No Google Flow tab found"**
Open `labs.google/flow` in Chrome and navigate into a project. The extension needs an active Flow project tab open.

**Generate button shows Done but Flow doesn't move**
Check the Activity Log panel. Look for errors in red. The most common cause is the prompt box issue — click manually inside the Flow prompt box once, then try again.

**Settings buttons not working**
This is a known issue with Radix UI components. The `radixClick()` function sends the correct pointer events but some settings changes are unreliable. Use the Flow UI directly for settings; use the app for prompt + generate automation only.

**Content script not loading**
If `PING` fails after the bridge connects, it means `content.js` isn't running in the Flow tab. Go to the Flow tab and hard refresh it (`Ctrl+Shift+R`).

---

## Technical Notes for Developers

**Why `radixClick` instead of `.click()`**
Google Flow uses Radix UI. Radix triggers on `pointerdown` events, not `click` or `mousedown`. A regular `.click()` call is ignored. `radixClick()` dispatches the full pointer event sequence Radix expects.

**Why `beforeinput` for the prompt box**
The prompt box uses Slate.js, which maintains its own internal state tree separate from the DOM. Writing text directly to the DOM (via `innerHTML`, `value`, or `execCommand`) doesn't update Slate's model — so Flow thinks the box is still empty. Dispatching a `beforeinput` event with `inputType: "insertText"` is how real browsers tell Slate about new text.

**Why `readFlowState()` reads only text nodes**
When the settings dropdown is open, `textContent` on the settings button includes all the dropdown option text — including counts like `x4` — which causes the mode to be misread as "video" even in image mode. Reading only `TEXT_NODE` direct children (skipping element children) gives just the button label.

**CSS class selectors**
Flow uses CSS-in-JS (styled-components). Class names like `sc-46973129-1` are generated hashes that can change when Google updates Flow. Where we use them, we always have a structural fallback. If things break after a Flow update, look for selectors starting with `sc-` and replace them.
