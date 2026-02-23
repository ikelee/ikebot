import { describe, expect, test } from "vitest";
import { onAgentEvent, registerAgentRunContext } from "./agent-events.js";
import {
  beginToolLoop,
  beginUserInput,
  endAgentLoop,
  endToolLoop,
  endUserInput,
  ensureAgentLoop,
  recordModelCall,
  resetAgentTelemetryForTests,
} from "./agent-telemetry.js";

describe("agent-telemetry hierarchy", () => {
  test("emits user_input -> agent_loop -> tool_loop -> model_call with rollups", () => {
    resetAgentTelemetryForTests();
    const runId = `run-${Date.now()}`;
    registerAgentRunContext(runId, {
      sessionKey: "session-telemetry",
      verboseLevel: "on",
      agentId: "workouts",
    });

    const events: Array<{ kind?: string; data: Record<string, unknown> }> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== runId || evt.stream !== "telemetry") {
        return;
      }
      events.push({
        kind: typeof evt.data.kind === "string" ? evt.data.kind : undefined,
        data: evt.data,
      });
    });

    const userInputId = beginUserInput({ runId, sessionKey: "session-telemetry", bodyChars: 42 });
    const agentLoopId = ensureAgentLoop({
      runId,
      userInputId,
      sessionKey: "session-telemetry",
      agentId: "workouts",
    });
    const loop = beginToolLoop({
      runId,
      userInputId,
      agentLoopId,
      sessionKey: "session-telemetry",
      agentId: "workouts",
    });

    recordModelCall({
      runId,
      userInputId,
      agentLoopId,
      toolLoopId: loop.toolLoopId,
      sessionKey: "session-telemetry",
      agentId: "workouts",
      provider: "ollama",
      model: "qwen2.5:14b",
      attemptIndex: loop.attemptIndex,
      attemptType: loop.attemptType,
      usage: { input: 123, output: 45, total: 168 },
      finishReason: "stop",
      toolCallsRequested: 1,
      status: "ok",
    });

    endToolLoop({
      runId,
      toolLoopId: loop.toolLoopId,
      sessionKey: "session-telemetry",
      status: "ok",
      toolCallCount: 1,
    });
    endAgentLoop({
      runId,
      sessionKey: "session-telemetry",
      agentId: "workouts",
      status: "ok",
    });
    endUserInput({ runId, status: "ok" });

    stop();

    const kinds = events.map((evt) => evt.kind);
    expect(kinds).toEqual([
      "user_input.start",
      "agent_loop.start",
      "tool_loop.start",
      "model_call.start",
      "model_call.end",
      "tool_loop.end",
      "agent_loop.end",
      "user_input.end",
    ]);

    const toolLoopEnd = events.find((evt) => evt.kind === "tool_loop.end")?.data;
    expect(toolLoopEnd?.modelCallCount).toBe(1);
    expect(toolLoopEnd?.toolCallCount).toBe(1);
    expect(toolLoopEnd?.usageTotals).toMatchObject({ input: 123, output: 45, total: 168 });

    const agentLoopEnd = events.find((evt) => evt.kind === "agent_loop.end")?.data;
    expect(agentLoopEnd?.toolLoopCount).toBe(1);
    expect(agentLoopEnd?.modelCallCount).toBe(1);
    expect(agentLoopEnd?.usageTotals).toMatchObject({ input: 123, output: 45, total: 168 });

    const userInputEnd = events.find((evt) => evt.kind === "user_input.end")?.data;
    expect(userInputEnd?.agentLoopCount).toBe(1);
  });
});
