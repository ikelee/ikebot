import type { AgentBootstrapHookContext } from "../extensibility/hooks/internal-hooks.js";
import type { OpenClawConfig } from "../infra/config/config.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";
import {
  createInternalHookEvent,
  triggerInternalHook,
} from "../extensibility/hooks/internal-hooks.js";
import { resolveAgentIdFromSessionKey } from "../infra/routing/session-key.js";

export async function applyBootstrapHookOverrides(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId ?? "unknown";
  const agentId =
    params.agentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  const context: AgentBootstrapHookContext = {
    workspaceDir: params.workspaceDir,
    bootstrapFiles: params.files,
    cfg: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId,
  };
  const event = createInternalHookEvent("agent", "bootstrap", sessionKey, context);
  await triggerInternalHook(event);
  const updated = (event.context as AgentBootstrapHookContext).bootstrapFiles;
  return Array.isArray(updated) ? updated : params.files;
}
