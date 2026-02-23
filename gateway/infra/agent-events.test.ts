import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  clearAgentRunContext,
  emitAgentEvent,
  flushTelemetryWritesForTest,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "./agent-events.js";

describe("agent-events sequencing", () => {
  test("stores and clears run context", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-1", { sessionKey: "main" });
    expect(getAgentRunContext("run-1")?.sessionKey).toBe("main");
    clearAgentRunContext("run-1");
    expect(getAgentRunContext("run-1")).toBeUndefined();
  });

  test("maintains monotonic seq per runId", async () => {
    const seen: Record<string, number[]> = {};
    const stop = onAgentEvent((evt) => {
      const list = seen[evt.runId] ?? [];
      seen[evt.runId] = list;
      list.push(evt.seq);
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });

    stop();

    expect(seen["run-1"]).toEqual([1, 2, 3]);
    expect(seen["run-2"]).toEqual([1]);
  });

  test("preserves compaction ordering on the event bus", async () => {
    const phases: Array<string> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-1") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "compaction", data: { phase: "start" } });
    emitAgentEvent({
      runId: "run-1",
      stream: "compaction",
      data: { phase: "end", willRetry: false },
    });

    stop();

    expect(phases).toEqual(["start", "end"]);
  });

  test("appends telemetry events to telemetry.jsonl", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telemetry-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    try {
      emitAgentEvent({
        runId: "run-telemetry-file",
        stream: "telemetry",
        data: { kind: "model_call.end", probe: true },
      });
      await flushTelemetryWritesForTest();
      const telemetryPath = path.join(tempStateDir, "logs", "telemetry.jsonl");
      const content = await fs.readFile(telemetryPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const parsed = JSON.parse(lines[lines.length - 1] ?? "{}");
      expect(parsed.stream).toBe("telemetry");
      expect(parsed.source).toBe("test");
      expect(parsed.runId).toBe("run-telemetry-file");
      expect(parsed.data?.kind).toBe("model_call.end");
    } finally {
      if (prevStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      }
      await fs.rm(tempStateDir, { recursive: true, force: true });
    }
  });
});
