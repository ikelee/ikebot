/**
 * Finance Agent
 *
 * Purpose: Track spendings from manual entries and screenshots, categorize spend, weekly totals.
 * Access: governed by runtime tool policy/config.
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

/** Pi config: minimal prompt/bootstrap defaults for finance workflows. */
export const FINANCE_PI_CONFIG: AgentPiConfig = {
  preset: "minimal",
  bootstrapFiles: ["SOUL", "TOOLS"],
  promptMode: "minimal",
  skills: false,
};

export class FinanceAgent extends Agent {
  constructor() {
    const config: AgentConfig = {
      id: FINANCE_AGENT_ID,
      name: "Finance",
      purpose: "Track spendings, categorize spend, weekly audits, and split reminders",
      access: {
        data: [],
        documents: ["SOUL", "TOOLS"],
        scripts: ["tesseract"],
        features: ["exec_allowlist", "cron"],
        skills: [],
        tools: ["read", "write", "exec", "cron", "sessions_spawn", "sessions_list"],
        canDelegate: true,
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
