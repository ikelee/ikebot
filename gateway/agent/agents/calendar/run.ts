/**
 * Calendar Agent – Pi path invocation
 *
 * Invokes the Pi embedded flow with calendar-specific config (agentId=calendar,
 * piConfig from agents.list[calendar].pi). Agent config flows into piConfig via
 * resolvePiConfig(cfg, agentId).
 */

import { resolveAgentConfig, resolveAgentDir } from "../../../runtime/agent-scope.js";
import { runPreparedReply } from "../../pipeline/reply/reply-building/get-reply-run.js";
import { runComplexReply } from "../complex/index.js";

export type RunCalendarReplyParams = Parameters<typeof runPreparedReply>[0];

const CALENDAR_AGENT_ID = "calendar";

/**
 * Run the calendar agent path. Agent config from agents.list[calendar] flows into
 * piConfig via resolvePiConfig(cfg, agentId) in get-reply-run when building followupRun.run.
 *
 * If the calendar agent is not in config, falls back to complex agent.
 */
export async function runCalendarReply(
  params: RunCalendarReplyParams,
): Promise<ReturnType<typeof runPreparedReply>> {
  const { cfg } = params;
  const agentConfig = resolveAgentConfig(cfg, CALENDAR_AGENT_ID);

  if (!agentConfig) {
    console.warn(
      `[calendar] agent "${CALENDAR_AGENT_ID}" not in agents.list; falling back to complex agent`,
    );
    return runComplexReply(params);
  }

  const agentDir = resolveAgentDir(cfg, CALENDAR_AGENT_ID);
  return runPreparedReply({
    ...params,
    agentId: CALENDAR_AGENT_ID,
    agentDir,
    replyTier: "complex",
  });
}
