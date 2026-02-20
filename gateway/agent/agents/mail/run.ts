/**
 * Mail Agent – Pi path invocation
 */

import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../../runtime/agent-scope.js";
import { runPreparedReply } from "../../pipeline/reply/reply-building/get-reply-run.js";
import { runComplexReply } from "../complex/index.js";

export type RunMailReplyParams = Parameters<typeof runPreparedReply>[0];

const MAIL_AGENT_ID = "mail";

export async function runMailReply(
  params: RunMailReplyParams,
): Promise<ReturnType<typeof runPreparedReply>> {
  const { cfg } = params;
  const agentConfig = resolveAgentConfig(cfg, MAIL_AGENT_ID);

  if (!agentConfig) {
    console.warn(
      `[mail] agent "${MAIL_AGENT_ID}" not in agents.list; falling back to complex agent`,
    );
    return runComplexReply(params);
  }

  const agentDir = resolveAgentDir(cfg, MAIL_AGENT_ID);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, MAIL_AGENT_ID);
  return runPreparedReply({
    ...params,
    agentId: MAIL_AGENT_ID,
    agentDir,
    workspaceDir,
    replyTier: "complex",
  });
}
