import type { AgentOnboardingContext, AgentOnboardingHandler } from "./types.js";

export function createNoopOnboardingHandler(agentId: string): AgentOnboardingHandler {
  return {
    agentId,
    async initializeFiles(_context: AgentOnboardingContext): Promise<void> {},
    async maybeHandleOnboarding(_context: AgentOnboardingContext) {
      return undefined;
    },
  };
}
