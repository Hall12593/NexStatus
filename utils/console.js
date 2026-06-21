/**
 * src/utils/console.js
 * Simple logger with colored output and optional file logging.
 * Supports log level configuration via environment variables.
 */

require("colors");
const fs = require("fs");

// ── Configuration ─────────────────────────────────────────────────────────────
const SAVE_LOGS = process.env.SAVE_LOGS === "true";
const LOG_FILE = "./terminal.log";

/**
 * Format and log a message to console and optionally to file.
 * @param {string} type - Log type (Info, Error, Warning, OK)
 * @param {string} color - Color for the console output
 * @param {...any} message - Message parts to log
 */
function logSafe(type, color, ...message) {
  const time   = new Date().toLocaleTimeString("en-US", { hour12: false });
  const joined = message.join(" ");
  const logLine = `[${time}] [${type}] ${joined}`;

  // Console output with color
  try {
    console[type === "Error" ? "error" : type === "Warning" ? "warn" : "info"](
      `[${time}]`.gray, `[${type}]`[color], joined
    );
  } catch {
    // Fallback if colors library fails
    console.log(logLine);
  }

  // File logging (if enabled)
  if (SAVE_LOGS) {
    try {
      fs.appendFileSync(LOG_FILE, logLine + "\n", "utf-8");
    } catch {
      // Ignore file write errors
    }
  }
}

const info    = (...m) => logSafe("Info",    "blue",   ...m);
const success = (...m) => logSafe("OK",      "green",  ...m);
const error   = (...m) => logSafe("Error",   "red",    ...m);
const warn    = (...m) => logSafe("Warning", "yellow", ...m);

module.exports = { info, success, error, warn };
