// ============================================================
// logger.js — FlowPilot Shared Logger
// Logs go to: chrome.storage.local (persistent) + console
// Log levels: INFO, SUCCESS, WARN, ERROR
// ============================================================

const LOG_KEY = "flowpilot_logs";
const MAX_LOGS = 200; // Keep last 200 entries so storage doesn't explode

const LogLevel = {
  INFO: "INFO",
  SUCCESS: "SUCCESS",
  WARN: "WARN",
  ERROR: "ERROR",
};

/**
 * Write a log entry to chrome.storage.local and the console.
 * @param {string} level - One of LogLevel values
 * @param {string} source - Where this log came from e.g. "content", "background", "popup"
 * @param {string} message - Human-readable message
 * @param {any} [data] - Optional extra data (object, error, etc.)
 */
async function writeLog(level, source, message, data = null) {
  const entry = {
    id: Date.now() + Math.random(), // unique enough for our purposes
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    data: data ? JSON.stringify(data, Object.getOwnPropertyNames(data)) : null,
  };

  // Console output with color coding
  const colors = {
    INFO: "color: #60a5fa",       // blue
    SUCCESS: "color: #4ade80",    // green
    WARN: "color: #facc15",       // yellow
    ERROR: "color: #f87171",      // red
  };
  console.log(
    `%c[FlowPilot][${level}][${source}] ${message}`,
    colors[level] || "",
    data || ""
  );

  // Persist to storage
  try {
    const result = await chrome.storage.local.get(LOG_KEY);
    const logs = result[LOG_KEY] || [];
    logs.push(entry);

    // Trim to last MAX_LOGS entries
    if (logs.length > MAX_LOGS) {
      logs.splice(0, logs.length - MAX_LOGS);
    }

    await chrome.storage.local.set({ [LOG_KEY]: logs });
  } catch (err) {
    // Don't throw — logging must never crash the app
    console.error("[FlowPilot][Logger] Failed to persist log:", err);
  }

  return entry;
}

/**
 * Read all stored logs
 * @returns {Promise<Array>}
 */
async function readLogs() {
  try {
    const result = await chrome.storage.local.get(LOG_KEY);
    return result[LOG_KEY] || [];
  } catch (err) {
    console.error("[FlowPilot][Logger] Failed to read logs:", err);
    return [];
  }
}

/**
 * Clear all stored logs
 */
async function clearLogs() {
  try {
    await chrome.storage.local.remove(LOG_KEY);
  } catch (err) {
    console.error("[FlowPilot][Logger] Failed to clear logs:", err);
  }
}

// Convenience wrappers
const log = {
  info:    (source, msg, data) => writeLog(LogLevel.INFO,    source, msg, data),
  success: (source, msg, data) => writeLog(LogLevel.SUCCESS, source, msg, data),
  warn:    (source, msg, data) => writeLog(LogLevel.WARN,    source, msg, data),
  error:   (source, msg, data) => writeLog(LogLevel.ERROR,   source, msg, data),
};
