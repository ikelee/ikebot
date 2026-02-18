/**
 * Complex Agent (Full Pi path)
 *
 * Model Tier: Large (Claude, GPT-4, etc.)
 * Purpose: Full tool use, planning, multi-step execution, all bootstrap files
 * Access: All tools, skills, documents – piConfig from agents.list[agentId].pi
 *
 * Invoked via runComplexReply in run.ts when router decision is "escalate".
 * Uses full Pi path: runPreparedReply → runReplyAgent → runEmbeddedAttempt.
 */

import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../../core/agent.js";

export class ComplexAgent extends Agent {
  constructor() {
    const config: AgentConfig = {
      id: "complex",
      name: "Complex",
      purpose:
        "Full tool use, planning, and multi-step execution with all bootstrap files and skills",
      access: {
        data: ["*"],
        documents: ["*"],
        scripts: ["*"],
        features: ["*"],
        skills: ["*"],
        tools: ["*"],
        canDelegate: true,
      },
      model: {
        tier: "large",
        provider: "ollama",
        modelId: "qwen2.5:72b",
        maxTokens: 8192,
        temperature: 0.7,
      },
    };
    super(config);
  }

  /**
   * Complex agent is invoked via runComplexReply, not executeAgent.
   */
  async execute(_input: AgentInput, _context: AgentExecutionContext): Promise<AgentOutput> {
    throw new Error(
      "ComplexAgent.execute() should not be called directly; use runComplexReply instead",
    );
  }
}
