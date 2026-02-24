import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/config/config.js", () => {
  return {
    loadConfig: vi.fn(() => ({
      session: {},
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.2",
                cost: {
                  input: 1,
                  output: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
              },
            ],
          },
        },
      },
    })),
  };
});

vi.mock("../session-utils.js", () => {
  return {
    loadCombinedSessionStoreForGateway: vi.fn(() => ({
      storePath: "(multiple)",
      store: {
        "agent:main:test-session": {
          sessionId: "sess-1",
          label: "Test Session",
          updatedAt: 1000,
          origin: { provider: "webchat" },
          chatType: "direct",
        },
      },
    })),
  };
});

import { usageHandlers } from "./usage.js";

describe("usage.telemetry", () => {
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

  it("aggregates user calls and model usage by session key", async () => {
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-telemetry-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const logsDir = path.join(tempStateDir, "logs");
    await fs.mkdir(logsDir, { recursive: true });
    const telemetryPath = path.join(logsDir, "telemetry.jsonl");

    await fs.writeFile(
      telemetryPath,
      [
        JSON.stringify({
          runId: "run-1",
          stream: "telemetry",
          sessionKey: "agent:main:test-session",
          source: "test",
          ts: Date.UTC(2026, 1, 2, 12, 0, 0),
          data: { kind: "user_input.start", userInputId: "u-1" },
        }),
        JSON.stringify({
          runId: "run-1",
          stream: "telemetry",
          sessionKey: "agent:main:test-session",
          source: "test",
          ts: Date.UTC(2026, 1, 2, 12, 0, 1),
          data: {
            kind: "model_call.end",
            userInputId: "u-1",
            provider: "openai-codex",
            model: "gpt-5.1-codex-mini",
            status: "ok",
            usage: {
              input: 10,
              output: 5,
              total: 15,
            },
          },
        }),
        JSON.stringify({
          runId: "run-1",
          stream: "telemetry",
          sessionKey: "agent:main:test-session",
          source: "test",
          ts: Date.UTC(2026, 1, 2, 12, 0, 2),
          data: {
            kind: "tool_loop.end",
            status: "ok",
            toolCallCount: 2,
            toolNames: ["calendar_update", "calendar_update"],
          },
        }),
        JSON.stringify({
          runId: "run-1",
          stream: "telemetry",
          sessionKey: "agent:main:test-session",
          source: "test",
          ts: Date.UTC(2026, 1, 2, 12, 0, 3),
          data: {
            kind: "user_input.end",
            userInputId: "u-1",
            status: "ok",
            durationMs: 3000,
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const respond = vi.fn();
    await usageHandlers["usage.telemetry"]({
      respond,
      params: {
        startDate: "2026-02-02",
        endDate: "2026-02-02",
        limit: 100,
      },
    } as unknown as Parameters<(typeof usageHandlers)["usage.telemetry"]>[0]);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const payload = respond.mock.calls[0]?.[1] as {
      sessions: Array<{
        key: string;
        sessionSource?: "test" | "live";
        usage: {
          totalTokens: number;
          toolUsage?: {
            totalCalls: number;
            uniqueTools: number;
            tools: Array<{ name: string; count: number }>;
          };
          messageCounts?: { user: number; toolCalls: number };
        } | null;
      }>;
      totals: { totalTokens: number };
      aggregates: {
        tools: {
          totalCalls: number;
          uniqueTools: number;
          tools: Array<{ name: string; count: number }>;
        };
      };
    };
    expect(payload.totals.totalTokens).toBe(15);
    expect(payload.totals.totalCost).toBeCloseTo(0.0000125, 10);
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]?.key).toBe("agent:main:test-session");
    expect(payload.sessions[0]?.sessionSource).toBe("test");
    expect(payload.sessions[0]?.usage?.messageCounts?.user).toBe(1);
    expect(payload.sessions[0]?.usage?.messageCounts?.toolCalls).toBe(2);
    expect(payload.sessions[0]?.usage?.toolUsage?.totalCalls).toBe(2);
    expect(payload.sessions[0]?.usage?.toolUsage?.uniqueTools).toBe(1);
    expect(payload.sessions[0]?.usage?.toolUsage?.tools[0]).toEqual({
      name: "calendar_update",
      count: 2,
    });
    expect(payload.sessions[0]?.usage?.totalTokens).toBe(15);
    expect(payload.aggregates.tools.totalCalls).toBe(2);
    expect(payload.aggregates.tools.uniqueTools).toBe(1);
    expect(payload.aggregates.tools.tools[0]).toEqual({ name: "calendar_update", count: 2 });
  });
});
