import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testsHandlers } from "./tests.js";

const noop = () => {};

describe("tests.telemetry", () => {
  let tempStateDir: string | null = null;
  let prevStateDir: string | undefined;

  afterEach(async () => {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    prevStateDir = undefined;
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
  });

  it("returns parsed telemetry events with filters", async () => {
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tests-telemetry-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const logsDir = path.join(tempStateDir, "logs");
    await fs.mkdir(logsDir, { recursive: true });
    const telemetryPath = path.join(logsDir, "telemetry.jsonl");
    await fs.writeFile(
      telemetryPath,
      [
        JSON.stringify({
          runId: "run-a",
          seq: 1,
          stream: "telemetry",
          ts: 100,
          source: "test",
          data: { kind: "model_call.end", status: "ok", usage: { input: 10, output: 4 } },
        }),
        JSON.stringify({
          runId: "run-a",
          seq: 2,
          stream: "telemetry",
          ts: 200,
          source: "test",
          data: { kind: "tool_loop.end", status: "ok" },
        }),
        JSON.stringify({
          runId: "run-b",
          seq: 1,
          stream: "telemetry",
          ts: 220,
          source: "live",
          data: { kind: "model_call.end", status: "error" },
        }),
        JSON.stringify({
          runId: "run-c",
          seq: 1,
          stream: "assistant",
          ts: 260,
          source: "live",
          data: { kind: "ignored" },
        }),
        "not-json",
      ].join("\n"),
      "utf8",
    );

    const respond = vi.fn();
    await testsHandlers["tests.telemetry"]({
      req: { id: "1", type: "req", method: "tests.telemetry" },
      params: {
        runIds: ["run-a", "run-b"],
        sinceTs: 150,
      },
      respond,
      context: {} as Parameters<(typeof testsHandlers)["tests.telemetry"]>[0]["context"],
      client: null,
      isWebchatConnect: noop,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        events: [
          expect.objectContaining({ runId: "run-a", kind: "tool_loop.end", source: "test" }),
          expect.objectContaining({ runId: "run-b", kind: "model_call.end", source: "live" }),
        ],
      },
      undefined,
    );
  });

  it("rejects invalid params", async () => {
    const respond = vi.fn();
    await testsHandlers["tests.telemetry"]({
      req: { id: "2", type: "req", method: "tests.telemetry" },
      params: {
        runIds: [123],
      },
      respond,
      context: {} as Parameters<(typeof testsHandlers)["tests.telemetry"]>[0]["context"],
      client: null,
      isWebchatConnect: noop,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
