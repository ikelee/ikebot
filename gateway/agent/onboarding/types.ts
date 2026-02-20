import type { OpenClawConfig } from "../../infra/config/config.js";
import type { ReplyPayload } from "../pipeline/types.js";

export type AgentOnboardingContext = {
  agentId: string;
  cleanedBody: string;
  workspaceDir: string;
  cfg: OpenClawConfig;
  userIdentifier: string;
  sessionKey: string;
};

export interface AgentOnboardingHandler {
  agentId: string;
  initializeFiles(context: AgentOnboardingContext): Promise<void>;
  maybeHandleOnboarding(
    context: AgentOnboardingContext,
  ): Promise<ReplyPayload | ReplyPayload[] | undefined>;
}
