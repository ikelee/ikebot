import fs from "node:fs";
import path from "node:path";
import type { VerboseLevel } from "../agent/pipeline/thinking.js";
import { resolveStateDir } from "./config/paths.js";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  source?: "live" | "test";
  testRunId?: string;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  userInputId?: string;
  agentLoopId?: string;
  agentId?: string;
};

// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = new Map<string, number>();
const listeners = new Set<(evt: AgentEventPayload) => void>();
const runContextById = new Map<string, AgentRunContext>();
let telemetryWriteChain: Promise<void> = Promise.resolve();

function resolveTelemetryLogPath(): string {
  return path.join(resolveStateDir(process.env), "logs", "telemetry.jsonl");
}

function resolveEventSource(): "live" | "test" {
  const override = process.env.OPENCLAW_TELEMETRY_SOURCE?.trim().toLowerCase();
  if (override === "test" || override === "live") {
    return override;
  }
  const isTestRuntime =
    process.env.VITEST === "true" ||
    process.env.VITEST === "1" ||
    process.env.NODE_ENV === "test" ||
    typeof process.env.JEST_WORKER_ID === "string" ||
    process.env.BUN_TEST === "1";
  return isTestRuntime ? "test" : "live";
}

export function resolveTelemetryLogPathForRuntime(): string {
  return resolveTelemetryLogPath();
}

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
  if (context.userInputId && existing.userInputId !== context.userInputId) {
    existing.userInputId = context.userInputId;
  }
  if (context.agentLoopId && existing.agentLoopId !== context.agentLoopId) {
    existing.agentLoopId = context.agentLoopId;
  }
  if (context.agentId && existing.agentId !== context.agentId) {
    existing.agentId = context.agentId;
  }
}

export function getAgentRunContext(runId: string) {
  return runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  runContextById.delete(runId);
}

export function resetAgentRunContextForTest() {
  runContextById.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
  seqByRun.set(event.runId, nextSeq);
  const context = runContextById.get(event.runId);
  const sessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim()
      ? event.sessionKey
      : context?.sessionKey;
  const testRunId = process.env.OPENCLAW_TEST_RUN_ID?.trim();
  const telemetryData =
    event.stream === "telemetry" && testRunId
      ? {
          ...event.data,
          suiteRunId:
            typeof event.data?.suiteRunId === "string" && event.data.suiteRunId.trim().length > 0
              ? event.data.suiteRunId
              : testRunId,
        }
      : event.data;
  const enriched: AgentEventPayload = {
    ...event,
    data: telemetryData,
    testRunId: testRunId || undefined,
    sessionKey,
    source: resolveEventSource(),
    seq: nextSeq,
    ts: Date.now(),
  };
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
  if (event.stream === "telemetry") {
    // Best-effort append for durable telemetry; never block runtime/event delivery.
    telemetryWriteChain = telemetryWriteChain.then(async () => {
      try {
        const telemetryLogPath = resolveTelemetryLogPath();
        await fs.promises.mkdir(path.dirname(telemetryLogPath), { recursive: true });
        const line = JSON.stringify(enriched);
        await fs.promises.appendFile(telemetryLogPath, `${line}\n`, "utf8");
      } catch {
        // swallow telemetry persistence errors
      }
    });
  }
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function flushTelemetryWritesForTest(): Promise<void> {
  await telemetryWriteChain;
}
