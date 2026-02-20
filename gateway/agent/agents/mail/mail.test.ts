/**
 * Mail agent tests: routing, piConfig, fallback.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../infra/config/config.js";
import { resolvePiConfig } from "../../../runtime/agent-scope.js";
import { maybeRunAgentOnboarding } from "../../onboarding/service.js";
import { __resetOnboardingStateForTests, runAgentFlow } from "../../run.js";
import { runMailReply } from "./run.js";

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
vi.mock("../../onboarding/service.js", () => ({
  maybeRunAgentOnboarding: vi.fn(async () => undefined),
}));

const createMockConfig = (overrides?: Partial<OpenClawConfig>): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        routing: { enabled: true, classifierModel: "ollama/qwen2.5:3b" },
      },
      list: [
        { id: "main", default: true },
        {
          id: "mail",
          skills: ["gog"] as string[],
          tools: { exec: { security: "allowlist" as const, safeBins: ["gog"] } },
        },
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

describe("mail agent", () => {
  beforeEach(() => {
    __resetOnboardingStateForTests();
    vi.clearAllMocks();
    vi.mocked(maybeRunAgentOnboarding).mockResolvedValue(undefined);
    runPreparedReplyMock.mockResolvedValue({ text: "ok" });
  });

  describe("routing", () => {
    it('routes "check my email" to mail agent', async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"mail"}' }],
        usage: { input: 12, output: 10 },
      });

      const cfg = createMockConfig();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody: "check my email",
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
      expect(call.agentId).toBe("mail");
      expect(call.agentDir).toContain("mail");
    });

    it('routes "any new emails" to mail agent', async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"mail"}' }],
        usage: { input: 14, output: 10 },
      });

      const cfg = createMockConfig();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody: "any new emails?",
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
      expect(call.agentId).toBe("mail");
    });
  });

  describe("piConfig", () => {
    it("resolvePiConfig returns exec+sessions for mail agent", () => {
      const cfg = createMockConfig();
      const result = resolvePiConfig(cfg, "mail");

      expect(result.bootstrapFiles).toEqual(["SOUL", "TOOLS"]);
      expect(result.promptMode).toBe("minimal");
      expect(result.skills).toBe(false);
      expect(result.toolsAllow).toContain("exec");
      expect(result.toolsAllow).toContain("sessions_spawn");
    });

    it("runMailReply passes agentId=mail to runPreparedReply", async () => {
      const mailWorkspace = path.join("/tmp", "mail-agent-workspace");
      const cfg = createMockConfig({
        agents: {
          defaults: { routing: { enabled: true, classifierModel: "ollama/qwen2.5:3b" } },
          list: [
            { id: "main", default: true },
            {
              id: "mail",
              skills: ["gog"] as string[],
              tools: { exec: { security: "allowlist" as const, safeBins: ["gog"] } },
              workspace: mailWorkspace,
            },
          ],
        },
      });
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runMailReply(params);

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("mail");
      expect(call.workspaceDir).toBe(mailWorkspace);
      expect(call.replyTier).toBe("complex");
    });
  });

  describe("fallback when mail not in config", () => {
    it("runMailReply falls back to complex when mail agent missing", async () => {
      const cfg = createMockConfig({
        agents: {
          defaults: { routing: { enabled: true, classifierModel: "ollama/qwen2.5:3b" } },
          list: [{ id: "main", default: true }],
        },
      });
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runMailReply(params);

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("main");
    });
  });
});
