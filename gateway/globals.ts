import { getLogger, isFileLogLevelEnabled } from "./logging/logger.js";
import { theme } from "./terminal/theme.js";

let globalVerbose = false;
let globalYes = false;

/** In-process flag for full model I/O logging (set by gateway when --verbose). Avoids relying on process.env write. */
const LOG_FULL_MODEL_IO_KEY = "__OPENCLAW_LOG_FULL_MODEL_IO" as const;

export function setVerbose(v: boolean) {
  globalVerbose = v;
  try {
    (globalThis as unknown as Record<string, boolean>)[LOG_FULL_MODEL_IO_KEY] = v;
  } catch {
    /* ignore if globalThis is frozen */
  }
}

/** True if full model I/O should be logged (--verbose or OPENCLAW_LOG_FULL_MODEL_IO). */
export function isLogFullModelIoEnabled(): boolean {
  try {
    if ((globalThis as unknown as Record<string, boolean>)[LOG_FULL_MODEL_IO_KEY]) {
      return true;
    }
  } catch {
    /* ignore */
  }
  const env = (process.env.OPENCLAW_LOG_FULL_MODEL_IO ?? "").trim().toLowerCase();
  return env === "1" || env === "true" || env === "yes" || env === "on";
}

export function isVerbose() {
  return globalVerbose;
}

export function shouldLogVerbose() {
  if (globalVerbose || isFileLogLevelEnabled("debug")) {
    return true;
  }
  const env = (process.env.OPENCLAW_VERBOSE ?? "").trim().toLowerCase();
  return env === "1" || env === "true" || env === "yes" || env === "on";
}

export function logVerbose(message: string) {
  if (!shouldLogVerbose()) {
    return;
  }
  try {
    getLogger().debug({ message }, "verbose");
  } catch {
    // ignore logger failures to avoid breaking verbose printing
  }
  if (!globalVerbose) {
    return;
  }
  console.log(theme.muted(message));
}

export function logVerboseConsole(message: string) {
  if (!globalVerbose) {
    return;
  }
  console.log(theme.muted(message));
}

export function setYes(v: boolean) {
  globalYes = v;
}

export function isYes() {
  return globalYes;
}

export const success = theme.success;
export const warn = theme.warn;
export const info = theme.info;
export const danger = theme.error;
