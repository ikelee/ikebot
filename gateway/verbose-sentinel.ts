/**
 * Sentinel file for "verbose / full model I/O" so the gateway and agent code
 * agree even when they run in different bundles. Gateway writes on --verbose;
 * agent reads when deciding whether to log full prompts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SENTINEL_BASENAME = ".log-full-model-io";

function resolveOpenClawDir(): string {
  const home =
    (process.env.OPENCLAW_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? "").trim() ||
    (() => {
      try {
        return os.homedir();
      } catch {
        return "";
      }
    })();
  if (!home) {
    return "";
  }
  return path.join(home, ".openclaw");
}

let cachedPath: string | null = null;

export function getVerboseSentinelPath(): string {
  if (cachedPath !== null) {
    return cachedPath;
  }
  const dir = resolveOpenClawDir();
  cachedPath = dir ? path.join(dir, SENTINEL_BASENAME) : "";
  return cachedPath;
}

export function writeVerboseSentinel(): void {
  const p = getVerboseSentinelPath();
  if (!p) {
    return;
  }
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(p, String(Date.now()), "utf8");
  } catch {
    /* ignore */
  }
}

export function clearVerboseSentinel(): void {
  const p = getVerboseSentinelPath();
  if (!p) {
    return;
  }
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch {
    /* ignore */
  }
}

/** True if the sentinel file exists (gateway was started with --verbose). */
export function checkVerboseSentinelExists(): boolean {
  const p = getVerboseSentinelPath();
  if (!p) {
    return false;
  }
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
