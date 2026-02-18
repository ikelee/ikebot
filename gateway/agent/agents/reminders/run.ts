/**
 * Reminders Agent – Pi path invocation
 */

import { resolveAgentConfig, resolveAgentDir } from "../../../runtime/agent-scope.js";
import { runPreparedReply } from "../../pipeline/reply/reply-building/get-reply-run.js";
import { runComplexReply } from "../complex/index.js";

export type RunRemindersReplyParams = Parameters<typeof runPreparedReply>[0];

const REMINDERS_AGENT_ID = "reminders";

export async function runRemindersReply(
  params: RunRemindersReplyParams,
): Promise<ReturnType<typeof runPreparedReply>> {
  const { cfg } = params;
  const agentConfig = resolveAgentConfig(cfg, REMINDERS_AGENT_ID);

  if (!agentConfig) {
    console.warn(
      `[reminders] agent "${REMINDERS_AGENT_ID}" not in agents.list; falling back to complex agent`,
    );
    return runComplexReply(params);
  }

  const agentDir = resolveAgentDir(cfg, REMINDERS_AGENT_ID);
  return runPreparedReply({
    ...params,
    agentId: REMINDERS_AGENT_ID,
    agentDir,
    replyTier: "complex",
  });
}
