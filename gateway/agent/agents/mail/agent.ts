/**
 * Mail Agent
 *
 * Purpose: Gmail read (search, list inbox). Can invoke calendar/reminder via sessions_spawn.
 * Access: governed by runtime tool policy/config.
 *
 * Invoked via runMailReply when router decision is "mail".
 */

import type { AgentPiConfig } from "../../../infra/config/types.agents.js";
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../../core/agent.js";

export const MAIL_AGENT_ID = "mail";

/** Pi config: minimal prompt/bootstrap defaults for mail workflows. */
export const MAIL_PI_CONFIG: AgentPiConfig = {
  preset: "exec-only",
  bootstrapFiles: ["SOUL", "TOOLS"],
  promptMode: "minimal",
  skills: false,
};

export class MailAgent extends Agent {
  constructor() {
    const config: AgentConfig = {
      id: MAIL_AGENT_ID,
      name: "Mail",
      purpose: "Gmail read (search, list inbox). Can spawn calendar/reminder for scheduling.",
      access: {
        data: [],
        documents: ["SOUL", "TOOLS"],
        scripts: ["gog"],
        features: ["exec_allowlist"],
        skills: ["gog"],
        tools: ["exec"],
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
    throw new Error("MailAgent.execute() should not be called directly; use runMailReply instead");
  }
}
