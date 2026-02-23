import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerAgentRunContext } from "./agent-events.js";
import {
  beginToolLoop,
  beginUserInput,
  ensureAgentLoop,
  recordModelCall,
  resetAgentTelemetryForTests,
} from "./agent-telemetry.js";

const { telemetryLogInfo } = vi.hoisted(() => ({
  telemetryLogInfo: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: telemetryLogInfo,
  }),
}));

describe("agent-telemetry logging", () => {
  beforeEach(() => {
    telemetryLogInfo.mockReset();
    resetAgentTelemetryForTests();
    delete process.env.OPENCLAW_TEST_EMIT_MODEL_LOGS;
  });

  test("mirrors model_call telemetry to runtime logs when verbose is enabled", () => {
    const runId = `run-log-${Date.now()}`;
    registerAgentRunContext(runId, {
      sessionKey: "session-log",
      verboseLevel: "on",
      agentId: "workouts",
    });
    const userInputId = beginUserInput({ runId, sessionKey: "session-log", bodyChars: 12 });
    const agentLoopId = ensureAgentLoop({
      runId,
      userInputId,
      sessionKey: "session-log",
      agentId: "workouts",
    });
    const loop = beginToolLoop({
      runId,
      userInputId,
      agentLoopId,
      sessionKey: "session-log",
      agentId: "workouts",
    });

    recordModelCall({
      runId,
      userInputId,
      agentLoopId,
      toolLoopId: loop.toolLoopId,
      sessionKey: "session-log",
      agentId: "workouts",
      provider: "ollama",
      model: "qwen2.5:14b",
      attemptIndex: loop.attemptIndex,
      attemptType: loop.attemptType,
      usage: { input: 8, output: 3, total: 11 },
      status: "ok",
    });

    expect(telemetryLogInfo).toHaveBeenCalledWith(
      expect.stringContaining("[telemetry] model_call.end"),
    );
  });

  test("honors OPENCLAW_TEST_EMIT_MODEL_LOGS when verbose is off", () => {
    const runId = `run-log-flag-${Date.now()}`;
    registerAgentRunContext(runId, {
      sessionKey: "session-log-flag",
      verboseLevel: "off",
      agentId: "workouts",
    });
    const userInputId = beginUserInput({ runId, sessionKey: "session-log-flag", bodyChars: 9 });
    const agentLoopId = ensureAgentLoop({
      runId,
      userInputId,
      sessionKey: "session-log-flag",
      agentId: "workouts",
    });
    const loop = beginToolLoop({
      runId,
      userInputId,
      agentLoopId,
      sessionKey: "session-log-flag",
      agentId: "workouts",
    });

    recordModelCall({
      runId,
      userInputId,
      agentLoopId,
      toolLoopId: loop.toolLoopId,
      sessionKey: "session-log-flag",
      agentId: "workouts",
      provider: "ollama",
      model: "qwen2.5:14b",
      attemptIndex: loop.attemptIndex,
      attemptType: loop.attemptType,
      usage: { input: 3, output: 2, total: 5 },
      status: "ok",
    });
    expect(telemetryLogInfo).not.toHaveBeenCalled();

    process.env.OPENCLAW_TEST_EMIT_MODEL_LOGS = "1";

    recordModelCall({
      runId,
      userInputId,
      agentLoopId,
      toolLoopId: loop.toolLoopId,
      sessionKey: "session-log-flag",
      agentId: "workouts",
      provider: "ollama",
      model: "qwen2.5:14b",
      attemptIndex: loop.attemptIndex,
      attemptType: loop.attemptType,
      usage: { input: 4, output: 1, total: 5 },
      status: "ok",
    });
    expect(telemetryLogInfo).toHaveBeenCalledWith(
      expect.stringContaining("[telemetry] model_call.end"),
    );
  });
});
