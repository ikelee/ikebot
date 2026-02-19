import type { AnyAgentTool } from "./tools/common.js";
import { getGlobalHookRunner } from "../extensibility/plugins/hook-runner-global.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
      },
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      if (isPlainObject(params)) {
        return { blocked: false, params: { ...params, ...hookResult.params } };
      }
      return { blocked: false, params: hookResult.params };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const normalizedToolName = normalizeToolName(toolName);

  const describeReadWriteParams = (value: unknown): string => {
    if (!isPlainObject(value)) {
      return "params=non-object";
    }
    const pathValue = typeof value.path === "string" ? value.path : undefined;
    if (normalizedToolName === "read") {
      return pathValue ? `path=${pathValue}` : "path=(missing)";
    }
    if (normalizedToolName === "write") {
      const contentLen = typeof value.content === "string" ? value.content.length : undefined;
      const pathPart = pathValue ? `path=${pathValue}` : "path=(missing)";
      const contentPart =
        contentLen !== undefined ? `contentChars=${contentLen}` : "contentChars=(missing)";
      return `${pathPart} ${contentPart}`;
    }
    return "";
  };

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const toolStartAt = Date.now();
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      const shouldLogReadWrite = normalizedToolName === "read" || normalizedToolName === "write";
      if (shouldLogReadWrite) {
        const details = describeReadWriteParams(outcome.params);
        const idPart = toolCallId ? ` id=${toolCallId}` : "";
        log.info(`[tool-call] start tool=${normalizedToolName}${idPart} ${details}`.trim());
      }
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        if (shouldLogReadWrite) {
          const durationMs = Date.now() - toolStartAt;
          const idPart = toolCallId ? ` id=${toolCallId}` : "";
          log.info(`[tool-call] done tool=${normalizedToolName}${idPart} durationMs=${durationMs}`);
        }
        return result;
      } catch (err) {
        if (shouldLogReadWrite) {
          const durationMs = Date.now() - toolStartAt;
          const idPart = toolCallId ? ` id=${toolCallId}` : "";
          log.warn(
            `[tool-call] error tool=${normalizedToolName}${idPart} durationMs=${durationMs} error=${String(err)}`,
          );
        }
        throw err;
      }
    },
  };
}

export const __testing = {
  runBeforeToolCallHook,
  isPlainObject,
};
