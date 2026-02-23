import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTestsHistoryForTests, testsHandlers } from "./tests.js";

const noop = () => {};

describe("tests.history", () => {
  let tempStateDir: string | null = null;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    __resetTestsHistoryForTests();
  });

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

  it("returns persisted run history newest-first", async () => {
    const now = Date.now();
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tests-history-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const logsDir = path.join(tempStateDir, "logs");
    await fs.mkdir(logsDir, { recursive: true });
    const historyPath = path.join(logsDir, "test-runs.jsonl");
    await fs.writeFile(
      historyPath,
      [
        JSON.stringify({
          runId: "run-1",
          suiteId: "unit-fast",
          status: "ok",
          startedAt: now - 2_000,
          endedAt: now - 1_500,
          durationMs: 500,
          command: ["pnpm", "-s", "test:fast"],
          cwd: "/tmp/repo",
          ts: now - 1_500,
        }),
        JSON.stringify({
          runId: "run-2",
          suiteId: "agent-e2e",
          status: "error",
          startedAt: now - 1_000,
          endedAt: now - 400,
          durationMs: 600,
          command: ["pnpm", "-s", "test:e2e:agent-level"],
          cwd: "/tmp/repo",
          ts: now - 400,
        }),
      ].join("\n"),
      "utf8",
    );

    const respond = vi.fn();
    await testsHandlers["tests.history"]({
      req: { id: "1", type: "req", method: "tests.history" },
      params: { limit: 10 },
      respond,
      context: {} as Parameters<(typeof testsHandlers)["tests.history"]>[0]["context"],
      client: null,
      isWebchatConnect: noop,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        runs: [
          expect.objectContaining({ runId: "run-2", suiteId: "agent-e2e" }),
          expect.objectContaining({ runId: "run-1", suiteId: "unit-fast" }),
        ],
      },
      undefined,
    );
  });
});
