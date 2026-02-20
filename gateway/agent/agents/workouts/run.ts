/**
 * Workouts Agent – Pi path invocation
 */

import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../../runtime/agent-scope.js";
import { runPreparedReply } from "../../pipeline/reply/reply-building/get-reply-run.js";
import { runComplexReply } from "../complex/index.js";

export type RunWorkoutsReplyParams = Parameters<typeof runPreparedReply>[0];

const WORKOUTS_AGENT_ID = "workouts";

export async function runWorkoutsReply(
  params: RunWorkoutsReplyParams,
): Promise<ReturnType<typeof runPreparedReply>> {
  const { cfg } = params;
  const agentConfig = resolveAgentConfig(cfg, WORKOUTS_AGENT_ID);

  if (!agentConfig) {
    console.warn(
      `[workouts] agent "${WORKOUTS_AGENT_ID}" not in agents.list; falling back to complex agent`,
    );
    return runComplexReply(params);
  }

  const agentDir = resolveAgentDir(cfg, WORKOUTS_AGENT_ID);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, WORKOUTS_AGENT_ID);
  return runPreparedReply({
    ...params,
    agentId: WORKOUTS_AGENT_ID,
    agentDir,
    workspaceDir,
    replyTier: "complex",
  });
}
