/**
 * Workouts Agent
 *
 * Purpose: Track workouts, suggest exercises, track weekly progress. File-based storage.
 * Access: governed by runtime tool policy/config.
 *
 * Invoked via runWorkoutsReply when router decision is "workouts".
 */

import type { AgentPiConfig } from "../../../infra/config/types.agents.js";
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../../core/agent.js";

export const WORKOUTS_AGENT_ID = "workouts";

/** Pi config: minimal prompt/bootstrap defaults for workouts workflows. */
export const WORKOUTS_PI_CONFIG: AgentPiConfig = {
  preset: "minimal",
  bootstrapFiles: ["SOUL", "TOOLS"],
  promptMode: "minimal",
  session: false,
  skills: false,
  bootstrapMaxChars: 2_500,
  promptSections: {
    safety: false,
    cliQuickRef: false,
    reasoningFormat: false,
  },
  stream: {
    maxTokens: 2048,
    temperature: 0,
  },
};

export class WorkoutsAgent extends Agent {
  constructor() {
    const config: AgentConfig = {
      id: WORKOUTS_AGENT_ID,
      name: "Workouts",
      purpose: "Track workouts, suggest exercises, track weekly progress",
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
        maxTokens: 2048,
        temperature: 0,
      },
    };
    super(config);
  }

  async execute(_input: AgentInput, _context: AgentExecutionContext): Promise<AgentOutput> {
    throw new Error(
      "WorkoutsAgent.execute() should not be called directly; use runWorkoutsReply instead",
    );
  }
}
