/**
 * Model I/O logging: full prompt/response when verbose, truncated otherwise.
 * Used by run.ts, Router, SimpleResponder, and attempt.ts.
 */

import { isLogFullModelIoEnabled, shouldLogVerbose } from "../globals.js";
import { checkVerboseSentinelExists } from "../verbose-sentinel.js";

const PREVIEW_CHARS = 400;
const VERBOSE_CHUNK_CHARS = 2000;

function isFullModelIoLogEnabled(): boolean {
  if (shouldLogVerbose()) {
    return true;
  }
  if (isLogFullModelIoEnabled()) {
    return true;
  }
  return checkVerboseSentinelExists();
}

function previewForLog(text: string, maxChars: number): string {
  const t = text?.trim() ?? "";
  if (!t) {
    return "(empty)";
  }
  const oneLine = t.replace(/\s+/g, " ").slice(0, maxChars);
  return oneLine.length < t.length ? `${oneLine}…` : oneLine;
}

export type LogFn = (msg: string) => void;

/**
 * Log model input or output. When verbose: full content (chunked if long).
 * Otherwise: truncated preview + hint to use --verbose.
 */
export function logModelIo(logFn: LogFn, prefix: string, text: string, fullInVerbose = true): void {
  const t = text?.trim() ?? "";
  if (fullInVerbose && isFullModelIoLogEnabled() && t.length > 0) {
    for (let i = 0; i < t.length; i += VERBOSE_CHUNK_CHARS) {
      const chunk = t.slice(i, i + VERBOSE_CHUNK_CHARS);
      const part = Math.floor(i / VERBOSE_CHUNK_CHARS) + 1;
      const total = Math.ceil(t.length / VERBOSE_CHUNK_CHARS);
      const suffix = total > 1 ? ` (part ${part}/${total})` : "";
      logFn(`${prefix}${suffix}: ${chunk}`);
    }
  } else {
    logFn(`${prefix}: ${previewForLog(t, PREVIEW_CHARS)}`);
    if (fullInVerbose && t.length > PREVIEW_CHARS) {
      logFn(
        "model I/O truncated — run gateway with --verbose or set OPENCLAW_LOG_FULL_MODEL_IO=1 for full prompt/response",
      );
    }
  }
}
