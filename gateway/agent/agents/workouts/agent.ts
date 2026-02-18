/**
 * Workouts Agent
 *
 * Purpose: Track workouts, suggest exercises, track weekly progress. File-based storage.
 * Access: read, write – piConfig minimal, read+write only.
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

/** Pi config: read+write only for workouts.json in workspace. */
export const WORKOUTS_PI_CONFIG: AgentPiConfig = {
  preset: "minimal",
  bootstrapFiles: ["SOUL", "TOOLS"],
  promptMode: "minimal",
  tools: { allow: ["read", "write"] },
  skills: false,
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
        maxTokens: 4096,
        temperature: 0.3,
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
