import type { OpenClawConfig } from "../../infra/config/config.js";
import type { ReplyPayload } from "../pipeline/types.js";
import type { AgentOnboardingContext } from "./types.js";
import { getOnboardingHandler } from "./registry.js";

export type MaybeRunAgentOnboardingParams = {
  agentId: string;
  cleanedBody: string;
  workspaceDir: string;
  cfg: OpenClawConfig;
  userIdentifier: string;
  sessionKey: string;
};

export async function maybeRunAgentOnboarding(
  params: MaybeRunAgentOnboardingParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const handler = getOnboardingHandler(params.agentId);
  if (!handler) {
    return undefined;
  }

  const context: AgentOnboardingContext = {
    agentId: params.agentId,
    cleanedBody: params.cleanedBody,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    userIdentifier: params.userIdentifier,
    sessionKey: params.sessionKey,
  };

  await handler.initializeFiles(context);
  return handler.maybeHandleOnboarding(context);
}
