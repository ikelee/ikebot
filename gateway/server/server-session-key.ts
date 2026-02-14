import { getAgentRunContext, registerAgentRunContext } from "../infra/agent-events.js";
import { loadConfig } from "../infra/config/config.js";
import { loadSessionStore, resolveStorePath } from "../infra/config/sessions.js";
import { toAgentRequestSessionKey } from "../infra/routing/session-key.js";

export function resolveSessionKeyForRun(runId: string) {
  const cached = getAgentRunContext(runId)?.sessionKey;
  if (cached) {
    return cached;
  }
  const cfg = loadConfig();
  const storePath = resolveStorePath(cfg.session?.store);
  const store = loadSessionStore(storePath);
  const found = Object.entries(store).find(([, entry]) => entry?.sessionId === runId);
  const storeKey = found?.[0];
  if (storeKey) {
    const sessionKey = toAgentRequestSessionKey(storeKey) ?? storeKey;
    registerAgentRunContext(runId, { sessionKey });
    return sessionKey;
  }
  return undefined;
}
