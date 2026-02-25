/**
 * Calendar agent tests: routing, piConfig, and mock Google integration.
 *
 * Routing: "what do I have on Friday the 21st", "schedule a meeting with James tomorrow"
 * → classifier returns "calendar" → runCalendarReply invoked.
 *
 * piConfig: When calendar agent runs, compact bootstrap and minimal prompt defaults apply.
 *
 * Mock Google: Future e2e would mock exec to return fake gog calendar output when
 * command matches "gog calendar"; agent would then summarize events.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../infra/config/config.js";
import { resolvePiConfig } from "../../../runtime/agent-scope.js";
import { maybeRunAgentOnboarding } from "../../onboarding/service.js";
import { __resetOnboardingStateForTests, runAgentFlow } from "../../run.js";
import { runCalendarReply } from "./run.js";

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
          id: "calendar",
          skills: ["gog"],
          tools: { allow: ["exec"], exec: { security: "allowlist", safeBins: ["gog"] } },
          /* pi from agent.ts (pi-registry) when not in config */
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

describe("calendar agent", () => {
  beforeEach(() => {
    __resetOnboardingStateForTests();
    vi.clearAllMocks();
    vi.mocked(maybeRunAgentOnboarding).mockResolvedValue(undefined);
    runPreparedReplyMock.mockResolvedValue({ text: "ok" });
  });

  describe("routing", () => {
    const CALENDAR_ROUTING_CASES = [
      "what do I have on Friday, the 21st",
      "schedule a meeting with James tomorrow",
      "move my dentist appointment to next Tuesday at 3pm",
      "what's on my calendar this weekend",
    ] as const;

    for (const prompt of CALENDAR_ROUTING_CASES) {
      it(`routes "${prompt}" to calendar agent`, async () => {
        vi.mocked(completeSimple).mockResolvedValue({
          content: [{ type: "text", text: '{"decision":"calendar"}' }],
          usage: { input: 14, output: 10 },
        });

        const cfg = createMockConfig();
        const params = createMinimalRunPreparedReplyParams();
        params.cfg = cfg;

        await runAgentFlow({
          cleanedBody: prompt,
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
        expect(call.agentId).toBe("calendar");
        expect(call.agentDir).toContain("calendar");
      });
    }
  });

  describe("piConfig", () => {
    it("resolvePiConfig returns minimal calendar prompt defaults", () => {
      const cfg = createMockConfig();
      const result = resolvePiConfig(cfg, "calendar");

      expect(result.bootstrapFiles).toEqual(["SOUL", "TOOLS"]);
      expect(result.promptMode).toBe("minimal");
      expect(result.skills).toBe(false);
      expect(result.toolsAllow).toBeUndefined();
      expect(result.stream?.temperature).toBe(0);
      expect(result.promptSections?.safety).toBe(false);
      expect(result.promptSections?.cliQuickRef).toBe(false);
      expect(result.promptSections?.reasoningFormat).toBe(false);
    });

    it("runCalendarReply passes agentId=calendar to runPreparedReply", async () => {
      const calendarWorkspace = path.join("/tmp", "calendar-agent-workspace");
      const cfg = createMockConfig({
        agents: {
          defaults: { routing: { enabled: true, classifierModel: "ollama/qwen2.5:3b" } },
          list: [
            { id: "main", default: true },
            {
              id: "calendar",
              skills: ["gog"],
              tools: { allow: ["exec"], exec: { security: "allowlist", safeBins: ["gog"] } },
              workspace: calendarWorkspace,
            },
          ],
        },
      });
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runCalendarReply(params);

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("calendar");
      expect(call.workspaceDir).toBe(calendarWorkspace);
      expect(call.replyTier).toBe("complex");
    });
  });

  describe("fallback when calendar not in config", () => {
    it("runCalendarReply falls back to complex when calendar agent missing", async () => {
      const cfg = createMockConfig({
        agents: {
          defaults: { routing: { enabled: true, classifierModel: "ollama/qwen2.5:3b" } },
          list: [{ id: "main", default: true }],
        },
      });
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runCalendarReply(params);

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("main");
    });
  });
});
