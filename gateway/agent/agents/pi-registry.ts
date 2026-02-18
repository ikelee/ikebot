/**
 * Agent Pi config registry – piConfig defined in agent.ts files, passed down to resolvePiConfig.
 * Config agents.list[].pi overrides agent-defined defaults when present.
 * See agent/docs/AGENT_DEFINITION_OWNERSHIP.md for config vs code ownership.
 */

import type { AgentPiConfig } from "../../infra/config/types.agents.js";
import { CALENDAR_PI_CONFIG } from "./calendar/agent.js";
import { FINANCE_PI_CONFIG } from "./finance/agent.js";
import { MAIL_PI_CONFIG } from "./mail/agent.js";
import { MULTI_PI_CONFIG } from "./multi/agent.js";
import { REMINDERS_PI_CONFIG } from "./reminders/agent.js";
import { WORKOUTS_PI_CONFIG } from "./workouts/agent.js";

const AGENT_PI: Record<string, AgentPiConfig> = {
  calendar: CALENDAR_PI_CONFIG,
  finance: FINANCE_PI_CONFIG,
  mail: MAIL_PI_CONFIG,
  multi: MULTI_PI_CONFIG,
  reminders: REMINDERS_PI_CONFIG,
  workouts: WORKOUTS_PI_CONFIG,
};

export function getAgentPiConfig(agentId: string): AgentPiConfig | undefined {
  const id = agentId?.trim().toLowerCase();
  return id ? AGENT_PI[id] : undefined;
}
