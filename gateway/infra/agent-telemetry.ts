import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitAgentEvent, getAgentRunContext } from "./agent-events.js";

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

type UserInputState = {
  userInputId: string;
  runId: string;
  sessionKey?: string;
  startedAt: number;
  agentLoopCount: number;
};

type AgentLoopState = {
  agentLoopId: string;
  userInputId: string;
  runId: string;
  agentId: string;
  sessionKey?: string;
  startedAt: number;
  toolLoopCount: number;
  modelCallCount: number;
  usage: UsageTotals;
};

type ToolLoopState = {
  toolLoopId: string;
  userInputId: string;
  agentLoopId: string;
  runId: string;
  agentId: string;
  startedAt: number;
  modelCallCount: number;
  usage: UsageTotals;
  attemptIndex: number;
  attemptType: "primary" | "retry" | "fallback";
};

const EMPTY_USAGE = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

const userInputByRunId = new Map<string, UserInputState>();
const activeAgentLoopByKey = new Map<string, string>();
const agentLoopById = new Map<string, AgentLoopState>();
const activeToolLoopByRunId = new Map<string, string>();
const toolLoopById = new Map<string, ToolLoopState>();
const toolLoopCountByAgentLoopId = new Map<string, number>();
const log = createSubsystemLogger("telemetry");

function shouldLog(runId: string): boolean {
  if (process.env.OPENCLAW_TEST_EMIT_MODEL_LOGS === "1") {
    return true;
  }
  const level = getAgentRunContext(runId)?.verboseLevel;
  return level === "on" || level === "full";
}

function logLine(runId: string, message: string): void {
  if (!shouldLog(runId)) {
    return;
  }
  log.info(`[telemetry] ${message}`);
}

function mergeUsage(target: UsageTotals, usage?: UsageLike): void {
  if (!usage) {
    return;
  }
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  const total =
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  target.total += total;
}

function buildAgentKey(sessionKey: string | undefined, agentId: string): string {
  return `${sessionKey ?? "unknown"}::${agentId}`;
}

export function beginUserInput(params: {
  runId: string;
  sessionKey?: string;
  bodyChars?: number;
}): string {
  const userInputId = crypto.randomUUID();
  const state: UserInputState = {
    userInputId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    startedAt: Date.now(),
    agentLoopCount: 0,
  };
  userInputByRunId.set(params.runId, state);
  emitAgentEvent({
    runId: params.runId,
    stream: "telemetry",
    sessionKey: params.sessionKey,
    data: {
      kind: "user_input.start",
      userInputId,
      runId: params.runId,
      sessionKey: params.sessionKey,
      startedAt: state.startedAt,
      bodyChars: params.bodyChars,
    },
  });
  logLine(
    params.runId,
    `user_input.start id=${userInputId} session=${params.sessionKey ?? "unknown"}`,
  );
  return userInputId;
}

export function endUserInput(params: {
  runId: string;
  status: "ok" | "error";
  error?: string;
}): void {
  const state = userInputByRunId.get(params.runId);
  if (!state) {
    return;
  }
  userInputByRunId.delete(params.runId);
  const endedAt = Date.now();
  emitAgentEvent({
    runId: params.runId,
    stream: "telemetry",
    sessionKey: state.sessionKey,
    data: {
      kind: "user_input.end",
      userInputId: state.userInputId,
      runId: state.runId,
      sessionKey: state.sessionKey,
      startedAt: state.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - state.startedAt),
      agentLoopCount: state.agentLoopCount,
      status: params.status,
      error: params.error,
    },
  });
  logLine(
    params.runId,
    `user_input.end id=${state.userInputId} status=${params.status} durationMs=${Math.max(0, endedAt - state.startedAt)}`,
  );
}

export function ensureAgentLoop(params: {
  runId: string;
  userInputId: string;
  sessionKey?: string;
  agentId: string;
}): string {
  const key = buildAgentKey(params.sessionKey, params.agentId);
  const existingId = activeAgentLoopByKey.get(key);
  if (existingId && agentLoopById.has(existingId)) {
    return existingId;
  }
  const agentLoopId = crypto.randomUUID();
  const state: AgentLoopState = {
    agentLoopId,
    userInputId: params.userInputId,
    runId: params.runId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    startedAt: Date.now(),
    toolLoopCount: 0,
    modelCallCount: 0,
    usage: EMPTY_USAGE(),
  };
  agentLoopById.set(agentLoopId, state);
  activeAgentLoopByKey.set(key, agentLoopId);
  const userInput = userInputByRunId.get(params.runId);
  if (userInput) {
    userInput.agentLoopCount += 1;
  }
  emitAgentEvent({
    runId: params.runId,
    stream: "telemetry",
    sessionKey: params.sessionKey,
    data: {
      kind: "agent_loop.start",
      userInputId: params.userInputId,
      agentLoopId,
      runId: params.runId,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      startedAt: state.startedAt,
    },
  });
  logLine(
    params.runId,
    `agent_loop.start id=${agentLoopId} agent=${params.agentId} userInput=${params.userInputId}`,
  );
  return agentLoopId;
}

export function endAgentLoop(params: {
  runId: string;
  sessionKey?: string;
  agentId: string;
  status: "ok" | "error" | "aborted";
  error?: string;
}): void {
  const key = buildAgentKey(params.sessionKey, params.agentId);
  const agentLoopId = activeAgentLoopByKey.get(key);
  if (!agentLoopId) {
    return;
  }
  const state = agentLoopById.get(agentLoopId);
  if (!state) {
    activeAgentLoopByKey.delete(key);
    return;
  }
  activeAgentLoopByKey.delete(key);
  agentLoopById.delete(agentLoopId);
  const endedAt = Date.now();
  emitAgentEvent({
    runId: params.runId,
    stream: "telemetry",
    sessionKey: params.sessionKey,
    data: {
      kind: "agent_loop.end",
      userInputId: state.userInputId,
      agentLoopId: state.agentLoopId,
      runId: state.runId,
      agentId: state.agentId,
      sessionKey: state.sessionKey,
      startedAt: state.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - state.startedAt),
      toolLoopCount: state.toolLoopCount,
      modelCallCount: state.modelCallCount,
      usageTotals: {
        ...state.usage,
      },
      status: params.status,
      error: params.error,
    },
  });
  logLine(
    params.runId,
    `agent_loop.end id=${state.agentLoopId} agent=${state.agentId} status=${params.status} toolLoops=${state.toolLoopCount} modelCalls=${state.modelCallCount}`,
  );
}

export function beginToolLoop(params: {
  runId: string;
  userInputId: string;
  agentLoopId: string;
  sessionKey?: string;
  agentId: string;
}): {
  toolLoopId: string;
  attemptIndex: number;
  attemptType: "primary" | "retry" | "fallback";
} {
  const currentCount = toolLoopCountByAgentLoopId.get(params.agentLoopId) ?? 0;
  const attemptIndex = currentCount + 1;
  const attemptType: "primary" | "retry" | "fallback" = attemptIndex === 1 ? "primary" : "retry";
  toolLoopCountByAgentLoopId.set(params.agentLoopId, attemptIndex);
  const toolLoopId = crypto.randomUUID();
  const state: ToolLoopState = {
    toolLoopId,
    userInputId: params.userInputId,
    agentLoopId: params.agentLoopId,
    runId: params.runId,
    agentId: params.agentId,
    startedAt: Date.now(),
    modelCallCount: 0,
    usage: EMPTY_USAGE(),
    attemptIndex,
    attemptType,
  };
  toolLoopById.set(toolLoopId, state);
  activeToolLoopByRunId.set(params.runId, toolLoopId);
  emitAgentEvent({
    runId: params.runId,
    stream: "telemetry",
    sessionKey: params.sessionKey,
    data: {
      kind: "tool_loop.start",
      userInputId: params.userInputId,
      agentLoopId: params.agentLoopId,
      toolLoopId,
      runId: params.runId,
      agentId: params.agentId,
      attemptIndex,
      attemptType,
      startedAt: state.startedAt,
    },
  });
  logLine(
    params.runId,
    `tool_loop.start id=${toolLoopId} agent=${params.agentId} attempt=${attemptIndex}:${attemptType}`,
  );
  return { toolLoopId, attemptIndex, attemptType };
}

export function endToolLoop(params: {
  runId: string;
  toolLoopId: string;
  sessionKey?: string;
  status: "ok" | "error" | "timeout" | "aborted" | "retry";
  usage?: UsageLike;
  toolCallCount?: number;
  error?: string;
}): void {
  const state = toolLoopById.get(params.toolLoopId);
  if (!state) {
    return;
  }
  mergeUsage(state.usage, params.usage);
  toolLoopById.delete(params.toolLoopId);
  if (activeToolLoopByRunId.get(params.runId) === params.toolLoopId) {
    activeToolLoopByRunId.delete(params.runId);
  }
  const endedAt = Date.now();

  const agentLoop = agentLoopById.get(state.agentLoopId);
  if (agentLoop) {
    agentLoop.toolLoopCount += 1;
  }

  emitAgentEvent({
    runId: params.runId,
    stream: "telemetry",
    sessionKey: params.sessionKey,
    data: {
      kind: "tool_loop.end",
      userInputId: state.userInputId,
      agentLoopId: state.agentLoopId,
      toolLoopId: state.toolLoopId,
      runId: state.runId,
      agentId: state.agentId,
      attemptIndex: state.attemptIndex,
      attemptType: state.attemptType,
      startedAt: state.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - state.startedAt),
      modelCallCount: state.modelCallCount,
      toolCallCount: params.toolCallCount ?? 0,
      usageTotals: {
        ...state.usage,
      },
      status: params.status,
      error: params.error,
    },
  });
  logLine(
    params.runId,
    `tool_loop.end id=${state.toolLoopId} status=${params.status} modelCalls=${state.modelCallCount} toolCalls=${params.toolCallCount ?? 0}`,
  );
}

export function recordModelCall(params: {
  runId: string;
  userInputId: string;
  agentLoopId: string;
  toolLoopId: string;
  sessionKey?: string;
  agentId: string;
  provider: string;
  model: string;
  attemptIndex: number;
  attemptType: "primary" | "retry" | "fallback";
  usage?: UsageLike;
  finishReason?: string;
  toolCallsRequested?: number;
  status: "ok" | "error";
  error?: string;
}): void {
  const modelCallId = crypto.randomUUID();
  const startedAt = Date.now();
  emitAgentEvent({
    runId: params.runId,
    stream: "telemetry",
    sessionKey: params.sessionKey,
    data: {
      kind: "model_call.start",
      userInputId: params.userInputId,
      agentLoopId: params.agentLoopId,
      toolLoopId: params.toolLoopId,
      modelCallId,
      runId: params.runId,
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      attemptIndex: params.attemptIndex,
      attemptType: params.attemptType,
      startedAt,
    },
  });

  const endedAt = Date.now();
  emitAgentEvent({
    runId: params.runId,
    stream: "telemetry",
    sessionKey: params.sessionKey,
    data: {
      kind: "model_call.end",
      userInputId: params.userInputId,
      agentLoopId: params.agentLoopId,
      toolLoopId: params.toolLoopId,
      modelCallId,
      runId: params.runId,
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      attemptIndex: params.attemptIndex,
      attemptType: params.attemptType,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      usage: params.usage,
      finishReason: params.finishReason,
      toolCallsRequested: params.toolCallsRequested,
      status: params.status,
      error: params.error,
    },
  });
  logLine(
    params.runId,
    `model_call.end id=${modelCallId} provider=${params.provider}/${params.model} attempt=${params.attemptIndex}:${params.attemptType} in=${params.usage?.input ?? 0} out=${params.usage?.output ?? 0}`,
  );

  const toolLoop = toolLoopById.get(params.toolLoopId);
  if (toolLoop) {
    toolLoop.modelCallCount += 1;
    mergeUsage(toolLoop.usage, params.usage);
  }
  const agentLoop = agentLoopById.get(params.agentLoopId);
  if (agentLoop) {
    agentLoop.modelCallCount += 1;
    mergeUsage(agentLoop.usage, params.usage);
  }
}

export function getActiveToolLoopForRun(runId: string): ToolLoopState | undefined {
  const toolLoopId = activeToolLoopByRunId.get(runId);
  if (!toolLoopId) {
    return undefined;
  }
  return toolLoopById.get(toolLoopId);
}

export function resetAgentTelemetryForTests(): void {
  userInputByRunId.clear();
  activeAgentLoopByKey.clear();
  agentLoopById.clear();
  activeToolLoopByRunId.clear();
  toolLoopById.clear();
  toolLoopCountByAgentLoopId.clear();
}
