/**
 * Reminders Agent
 *
 * Purpose: Track reminders, schedule them via cron, list due reminders.
 * Access: governed by runtime tool policy/config.
 *
 * Invoked via runRemindersReply when router decision is "reminders".
 */

import type { AgentPiConfig } from "../../../infra/config/types.agents.js";
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../../core/agent.js";

export const REMINDERS_AGENT_ID = "reminders";

/** Pi config: minimal prompt/bootstrap defaults for reminders workflows. */
export const REMINDERS_PI_CONFIG: AgentPiConfig = {
  preset: "minimal",
  bootstrapFiles: ["SOUL", "TOOLS"],
  promptMode: "minimal",
  skills: false,
};

export class RemindersAgent extends Agent {
  constructor() {
    const config: AgentConfig = {
      id: REMINDERS_AGENT_ID,
      name: "Reminders",
      purpose: "Track and schedule reminders via cron; list due reminders",
      access: {
        data: [],
        documents: ["SOUL", "TOOLS"],
        scripts: [],
        features: ["cron"],
        skills: [],
        tools: ["cron", "read", "write"],
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
      "RemindersAgent.execute() should not be called directly; use runRemindersReply instead",
    );
  }
}
