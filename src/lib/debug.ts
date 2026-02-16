/**
 * Debug logging utility for conditional console output
 * Only logs in non-production environments unless DEBUG env var is set
 */

const DEBUG =
  process.env.DEBUG === "true" || process.env.NODE_ENV !== "production";

/**
 * Format timestamp for logging
 * Returns ISO 8601 format: 2026-01-26T19:56:23.123Z
 */
function formatTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Create a debug logger with a specific prefix and timestamp
 * Usage: const debug = createDebugger("TEMPLATE");
 *        debug("message", data); // logs: [2026-01-26T19:56:23.123Z] [TEMPLATE] message data
 */
export function createDebugger(prefix: string) {
  return (...args: unknown[]) => {
    if (DEBUG) {
      console.log(`[${formatTimestamp()}] [${prefix}]`, ...args);
    }
  };
}

/**
 * Generic debug log function with timestamp
 * Usage: debugLog("[PREFIX]", "message", data);
 */
export function debugLog(...args: unknown[]) {
  if (DEBUG) {
    console.log(`[${formatTimestamp()}]`, ...args);
  }
}

/**
 * Log info message with timestamp (always logs, regardless of debug mode)
 * Usage: logInfo("USER", "Login successful", { userId: 123 });
 */
export function logInfo(prefix: string, ...args: unknown[]) {
  console.log(`[${formatTimestamp()}] [${prefix}]`, ...args);
}

/**
 * Log warning message with timestamp (always logs, regardless of debug mode)
 * Usage: logWarn("CONFIG", "Missing API key", { key: "GEMINI_API_KEY" });
 */
export function logWarn(prefix: string, ...args: unknown[]) {
  console.warn(`[${formatTimestamp()}] [${prefix}]`, ...args);
}

/**
 * Log error message with timestamp (always logs, regardless of debug mode)
 * Usage: logError("API", "Request failed", error);
 */
export function logError(prefix: string, ...args: unknown[]) {
  console.error(`[${formatTimestamp()}] [${prefix}]`, ...args);
}

/**
 * Check if debug mode is enabled
 */
export function isDebugEnabled(): boolean {
  return DEBUG;
}
