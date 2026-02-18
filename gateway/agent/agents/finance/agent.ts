/**
 * Finance Agent
 *
 * Purpose: Track spendings, spending by category, weekly totals. File-based storage.
 * Access: read, write – piConfig minimal, read+write only.
 *
 * Invoked via runFinanceReply when router decision is "finance".
 */

import type { AgentPiConfig } from "../../../infra/config/types.agents.js";
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../../core/agent.js";

export const FINANCE_AGENT_ID = "finance";

/** Pi config: read+write only for spendings.json in workspace. */
export const FINANCE_PI_CONFIG: AgentPiConfig = {
  preset: "minimal",
  bootstrapFiles: ["SOUL", "TOOLS"],
  promptMode: "minimal",
  tools: { allow: ["read", "write"] },
  skills: false,
};

export class FinanceAgent extends Agent {
  constructor() {
    const config: AgentConfig = {
      id: FINANCE_AGENT_ID,
      name: "Finance",
      purpose: "Track spendings, spending by category, weekly totals",
      access: {
        data: [],
        documents: ["SOUL", "TOOLS"],
        scripts: [],
        features: [],
        skills: [],
        tools: ["read", "write"],
        canDelegate: false,
      },
      model: {
        tier: "medium",
        provider: "ollama",
        modelId: "qwen2.5:14b",
        maxTokens: 4096,
        temperature: 0.3,
      },
    };
    super(config);
  }

  async execute(_input: AgentInput, _context: AgentExecutionContext): Promise<AgentOutput> {
    throw new Error(
      "FinanceAgent.execute() should not be called directly; use runFinanceReply instead",
    );
  }
}
