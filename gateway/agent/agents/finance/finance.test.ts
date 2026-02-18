/**
 * Finance agent tests: routing, piConfig, fallback.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../infra/config/config.js";
import { resolvePiConfig } from "../../../runtime/agent-scope.js";
import { runAgentFlow } from "../../run.js";
import { runFinanceReply } from "./run.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

const runPreparedReplyMock = vi.fn();
const mockModel = { provider: "ollama", id: "qwen2.5:3b", api: "openai-completions" };

vi.mock("../../../runtime/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn(() => ({ model: mockModel })),
}));
vi.mock("../../../runtime/agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
}));
vi.mock("../../pipeline/reply/reply-building/get-reply-run.js", () => ({
  runPreparedReply: (...args: unknown[]) => runPreparedReplyMock(...args),
}));

const createMockConfig = (overrides?: Partial<OpenClawConfig>): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        routing: { enabled: true, classifierModel: "ollama/qwen2.5:3b" },
      },
      list: [
        { id: "main", default: true },
        { id: "finance", skills: [] as string[], tools: {} },
      ],
    },
    models: {
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: [
            {
              id: "qwen2.5:3b",
              name: "Qwen 2.5 3B",
              api: "openai-completions",
              contextWindow: 8192,
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
    },
    ...overrides,
  }) as OpenClawConfig;

const createMinimalRunPreparedReplyParams = () => ({
  ctx: {} as any,
  sessionCtx: {} as any,
  cfg: createMockConfig(),
  agentId: "main",
  agentDir: path.join("/tmp", "agents", "main", "agent"),
  agentCfg: {} as any,
  sessionCfg: {} as any,
  commandAuthorized: true,
  command: {} as any,
  commandSource: "chat" as const,
  allowTextCommands: true,
  directives: {} as any,
  defaultActivation: "mention" as const,
  resolvedThinkLevel: "off" as const,
  resolvedVerboseLevel: "off" as const,
  resolvedReasoningLevel: "off" as const,
  resolvedElevatedLevel: "off" as const,
  elevatedEnabled: false,
  elevatedAllowed: false,
  blockStreamingEnabled: true,
  resolvedBlockStreamingBreak: "text_end" as const,
  modelState: {} as any,
  provider: "ollama",
  model: "qwen2.5:3b",
  replyTier: "complex" as const,
  typing: {} as any,
  defaultProvider: "ollama",
  defaultModel: "llama-3.2-3b",
  timeoutMs: 60_000,
  isNewSession: false,
  resetTriggered: false,
  systemSent: false,
  sessionKey: "main",
  workspaceDir: "/tmp/workspace",
  abortedLastRun: false,
});

describe("finance agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runPreparedReplyMock.mockResolvedValue({ text: "ok" });
  });

  describe("routing", () => {
    it('routes "how much did I spend this week" to finance agent', async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"finance"}' }],
        usage: { input: 12, output: 10 },
      });

      const cfg = createMockConfig();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody: "how much did I spend this week",
        sessionKey: "main",
        provider: "ollama",
        model: "qwen2.5:3b",
        defaultProvider: "ollama",
        defaultModel: "qwen2.5:3b",
        aliasIndex: {},
        cfg,
        runPreparedReplyParams: params,
      });

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("finance");
      expect(call.agentDir).toContain("finance");
    });

    it('routes "log a purchase" to finance agent', async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"finance"}' }],
        usage: { input: 14, output: 10 },
      });

      const cfg = createMockConfig();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody: "log a purchase of $50 for groceries",
        sessionKey: "main",
        provider: "ollama",
        model: "qwen2.5:3b",
        defaultProvider: "ollama",
        defaultModel: "qwen2.5:3b",
        aliasIndex: {},
        cfg,
        runPreparedReplyParams: params,
      });

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("finance");
    });
  });

  describe("piConfig", () => {
    it("resolvePiConfig returns read+write for finance agent", () => {
      const cfg = createMockConfig();
      const result = resolvePiConfig(cfg, "finance");

      expect(result.bootstrapFiles).toEqual(["SOUL", "TOOLS"]);
      expect(result.promptMode).toBe("minimal");
      expect(result.skills).toBe(false);
      expect(result.toolsAllow).toContain("read");
      expect(result.toolsAllow).toContain("write");
    });

    it("runFinanceReply passes agentId=finance to runPreparedReply", async () => {
      const cfg = createMockConfig();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runFinanceReply(params);

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("finance");
      expect(call.replyTier).toBe("complex");
    });
  });

  describe("fallback when finance not in config", () => {
    it("runFinanceReply falls back to complex when finance agent missing", async () => {
      const cfg = createMockConfig({
        agents: {
          defaults: { routing: { enabled: true, classifierModel: "ollama/qwen2.5:3b" } },
          list: [{ id: "main", default: true }],
        },
      });
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runFinanceReply(params);

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("main");
    });
  });
});
