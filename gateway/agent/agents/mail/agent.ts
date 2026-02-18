/**
 * Mail Agent
 *
 * Purpose: Gmail read (search, list inbox). Can invoke calendar/reminder via sessions_spawn.
 * Access: exec (gog only), SOUL.md, TOOLS.md – piConfig exec-only.
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

/** Pi config: exec (gog gmail) + sessions_spawn for calendar/reminder handoff. */
export const MAIL_PI_CONFIG: AgentPiConfig = {
  preset: "exec-only",
  bootstrapFiles: ["SOUL", "TOOLS"],
  promptMode: "minimal",
  tools: { allow: ["exec", "sessions_spawn", "sessions_list"] },
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
