/**
 * Complex Agent – Full Pi path invocation
 *
 * Invokes the Pi embedded flow with full config (all bootstrap files, tools,
 * skills). Agent config from agents.list[agentId] flows into piConfig via
 * resolvePiConfig(cfg, agentId) in get-reply-run.
 */

import { runPreparedReply } from "../../pipeline/reply/reply-building/get-reply-run.js";

export type RunComplexReplyParams = Parameters<typeof runPreparedReply>[0];

/**
 * Run the complex (full) agent path. Uses agentId from params (typically "main").
 * piConfig is derived from agents.list[agentId].pi in get-reply-run.
 */
export async function runComplexReply(
  params: RunComplexReplyParams,
): Promise<ReturnType<typeof runPreparedReply>> {
  return runPreparedReply(params);
}
