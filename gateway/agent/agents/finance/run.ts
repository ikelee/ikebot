/**
 * Finance Agent – Pi path invocation
 */

import { resolveAgentConfig, resolveAgentDir } from "../../../runtime/agent-scope.js";
import { runPreparedReply } from "../../pipeline/reply/reply-building/get-reply-run.js";
import { runComplexReply } from "../complex/index.js";

export type RunFinanceReplyParams = Parameters<typeof runPreparedReply>[0];

const FINANCE_AGENT_ID = "finance";

export async function runFinanceReply(
  params: RunFinanceReplyParams,
): Promise<ReturnType<typeof runPreparedReply>> {
  const { cfg } = params;
  const agentConfig = resolveAgentConfig(cfg, FINANCE_AGENT_ID);

  if (!agentConfig) {
    console.warn(
      `[finance] agent "${FINANCE_AGENT_ID}" not in agents.list; falling back to complex agent`,
    );
    return runComplexReply(params);
  }

  const agentDir = resolveAgentDir(cfg, FINANCE_AGENT_ID);
  return runPreparedReply({
    ...params,
    agentId: FINANCE_AGENT_ID,
    agentDir,
    replyTier: "complex",
  });
}
