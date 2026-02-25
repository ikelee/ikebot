/**
 * Calendar Agent
 *
 * Model Tier: Medium (70B local or smaller cloud)
 * Purpose: Schedule/calendar operations via gog CLI
 * Access: governed by runtime tool policy/config.
 *
 * Invoked via runCalendarReply in run.ts when router decision is "calendar".
 * Does not go through the complex path; has its own branch in runAgentFlow.
 *
 * Ownership: Config (agents.list) defines which agents exist + user overrides.
 * Code (here, pi-registry) defines built-in pi defaults. See AGENT_DEFINITION_OWNERSHIP.md.
 */

import type { AgentPiConfig } from "../../../infra/config/types.agents.js";
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../../core/agent.js";

export const CALENDAR_AGENT_ID = "calendar";

/** Pi config for calendar agent: compact bootstrap and minimal prompt defaults. */
export const CALENDAR_PI_CONFIG: AgentPiConfig = {
  preset: "exec-only",
  bootstrapFiles: ["SOUL", "TOOLS"],
  promptMode: "minimal",
  skills: false,
  promptSections: {
    safety: false,
    cliQuickRef: false,
    reasoningFormat: false,
  },
  stream: {
    temperature: 0,
    maxTokens: 2048,
  },
};

export class CalendarAgent extends Agent {
  constructor() {
    const config: AgentConfig = {
      id: CALENDAR_AGENT_ID,
      name: "Calendar",
      purpose: "Schedule and calendar operations via gog CLI (list, create, update events)",
      access: {
        data: [],
        documents: ["SOUL", "TOOLS"],
        scripts: ["gog"],
        features: ["exec_allowlist"],
        skills: ["gog"],
        tools: ["exec"],
        canDelegate: false,
      },
      model: {
        tier: "medium",
        provider: "ollama",
        modelId: "qwen2.5:14b",
        maxTokens: 4096,
        temperature: 0,
      },
    };
    super(config);
  }

  /**
   * Calendar agent is invoked via runCalendarReply, not executeAgent.
   * This execute() is a placeholder for pattern consistency.
   */
  async execute(_input: AgentInput, _context: AgentExecutionContext): Promise<AgentOutput> {
    throw new Error(
      "CalendarAgent.execute() should not be called directly; use runCalendarReply instead",
    );
  }
}
