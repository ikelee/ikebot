/**
 * Multi Agent – Pi path invocation
 *
 * Orchestrates cross-domain queries by spawning specialized subagents.
 * orchestrateAgents: list of agent ids to spawn (from classifier). When omitted, multi infers from prompt.
 */

import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../../runtime/agent-scope.js";
import { runPreparedReply } from "../../pipeline/reply/reply-building/get-reply-run.js";
import { runComplexReply } from "../complex/index.js";

export type RunMultiReplyParams = Parameters<typeof runPreparedReply>[0] & {
  /** Agent ids to orchestrate (from classifier). When set, injected into multi agent prompt. */
  orchestrateAgents?: string[];
};

const MULTI_AGENT_ID = "multi";

export async function runMultiReply(
  params: RunMultiReplyParams,
): Promise<ReturnType<typeof runPreparedReply>> {
  const { cfg, orchestrateAgents } = params;
  const agentConfig = resolveAgentConfig(cfg, MULTI_AGENT_ID);

  if (!agentConfig) {
    console.warn(
      `[multi] agent "${MULTI_AGENT_ID}" not in agents.list; falling back to complex agent`,
    );
    return runComplexReply(params);
  }

  const agentDir = resolveAgentDir(cfg, MULTI_AGENT_ID);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, MULTI_AGENT_ID);
  const { orchestrateAgents: _omit, ...rest } = params;
  return runPreparedReply({
    ...rest,
    agentId: MULTI_AGENT_ID,
    agentDir,
    workspaceDir,
    replyTier: "complex",
    orchestrateAgents,
  });
}
