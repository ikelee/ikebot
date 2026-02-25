/**
 * Multi Agent
 *
 * Purpose: Orchestrate cross-domain queries (e.g. calendar + workouts) by spawning
 * specialized subagents and synthesizing their results.
 *
 * Access: governed by runtime tool policy/config.
 * Spawns calendar and workouts subagents; subagents announce results back to chat.
 *
 * Invoked via runMultiReply when router decision is "multi".
 */

import type { AgentPiConfig } from "../../../infra/config/types.agents.js";
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../../core/agent.js";

export const MULTI_AGENT_ID = "multi";

/** Pi config: minimal prompt/bootstrap defaults for multi-agent orchestration. */
export const MULTI_PI_CONFIG: AgentPiConfig = {
  preset: "minimal",
  bootstrapFiles: ["SOUL", "TOOLS"],
  promptMode: "minimal",
  skills: false,
};

export class MultiAgent extends Agent {
  constructor() {
    const config: AgentConfig = {
      id: MULTI_AGENT_ID,
      name: "Multi",
      purpose:
        "Orchestrate cross-domain queries (calendar + workouts) by spawning specialized subagents",
      access: {
        data: [],
        documents: ["SOUL", "TOOLS"],
        scripts: [],
        features: [],
        skills: [],
        tools: ["sessions_spawn", "sessions_list", "sessions_send", "session_status"],
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
      "MultiAgent.execute() should not be called directly; use runMultiReply instead",
    );
  }
}
