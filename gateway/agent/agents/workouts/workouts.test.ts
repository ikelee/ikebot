/**
 * Workouts agent tests: routing, piConfig, fallback.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../infra/config/config.js";
import { resolvePiConfig } from "../../../runtime/agent-scope.js";
import { maybeRunAgentOnboarding } from "../../onboarding/service.js";
import { __resetOnboardingStateForTests, runAgentFlow } from "../../run.js";
import { runWorkoutsReply } from "./run.js";

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
        { id: "workouts", skills: [] as string[], tools: {} },
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
  ctx: {} as Record<string, unknown>,
  sessionCtx: {} as Record<string, unknown>,
  cfg: createMockConfig(),
  agentId: "main",
  agentDir: path.join("/tmp", "agents", "main", "agent"),
  agentCfg: {} as Record<string, unknown>,
  sessionCfg: {} as Record<string, unknown>,
  commandAuthorized: true,
  command: {} as Record<string, unknown>,
  commandSource: "chat" as const,
  allowTextCommands: true,
  directives: {} as Record<string, unknown>,
  defaultActivation: "mention" as const,
  resolvedThinkLevel: "off" as const,
  resolvedVerboseLevel: "off" as const,
  resolvedReasoningLevel: "off" as const,
  resolvedElevatedLevel: "off" as const,
  elevatedEnabled: false,
  elevatedAllowed: false,
  blockStreamingEnabled: true,
  resolvedBlockStreamingBreak: "text_end" as const,
  modelState: {} as Record<string, unknown>,
  provider: "ollama",
  model: "qwen2.5:3b",
  replyTier: "complex" as const,
  typing: {} as Record<string, unknown>,
  defaultProvider: "ollama",
  defaultModel: "llama-3.2-3b",
  timeoutMs: 60_000,
  isNewSession: false,
  resetTriggered: false,
  systemSent: false,
  sessionKey: "main",
  workspaceDir: path.join(
    os.tmpdir(),
    `openclaw-workouts-test-${Math.random().toString(36).slice(2)}`,
  ),
  abortedLastRun: false,
});

async function seedOnboardedWorkoutState(workspaceDir: string): Promise<void> {
  const seeded = {
    schemaVersion: 2,
    profile: {
      goals: ["strength"],
      program: "PPL",
      bodyWeightLb: 180,
      coachingStyle: "supportive",
      equipment: ["barbell"],
      daysPerWeek: 4,
    },
    program: { name: "PPL", days: [] },
    events: [],
    views: { personalBests: { strength: {} } },
  };
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "workouts.json"), JSON.stringify(seeded), "utf8");
}

describe("workouts agent", () => {
  beforeEach(() => {
    __resetOnboardingStateForTests();
    vi.clearAllMocks();
    vi.mocked(maybeRunAgentOnboarding).mockResolvedValue(undefined);
    runPreparedReplyMock.mockResolvedValue({ text: "ok" });
  });

  describe("routing", () => {
    it('routes "log a workout" to workouts agent', async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"workouts"}' }],
        usage: { input: 12, output: 10 },
      });

      const cfg = createMockConfig();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;
      await seedOnboardedWorkoutState(params.workspaceDir);

      await runAgentFlow({
        cleanedBody: "log a workout",
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
      expect(call.agentId).toBe("workouts");
      expect(call.agentDir).toContain("workouts");
    });

    it('routes "what did I do this week" to workouts agent', async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"workouts"}' }],
        usage: { input: 14, output: 10 },
      });

      const cfg = createMockConfig();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;
      await seedOnboardedWorkoutState(params.workspaceDir);

      await runAgentFlow({
        cleanedBody: "what did I do this week for workouts",
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
      expect(call.agentId).toBe("workouts");
    });
  });

  describe("piConfig", () => {
    it("resolvePiConfig returns full defaults when workouts pi is omitted", () => {
      const cfg = createMockConfig();
      const result = resolvePiConfig(cfg, "workouts");

      expect(result.bootstrapFiles).toBeUndefined();
      expect(result.promptMode).toBe("full");
      expect(result.skills).toBe(true);
      expect(result.toolsAllow).toBeUndefined();
    });

    it("runWorkoutsReply passes agentId=workouts to runPreparedReply", async () => {
      const workoutsWorkspace = path.join(os.tmpdir(), "workouts-agent-workspace");
      const cfg = createMockConfig({
        agents: {
          defaults: { routing: { enabled: true, classifierModel: "ollama/qwen2.5:3b" } },
          list: [
            { id: "main", default: true },
            { id: "workouts", skills: [], tools: {}, workspace: workoutsWorkspace },
          ],
        },
      });
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runWorkoutsReply(params);

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("workouts");
      expect(call.workspaceDir).toBe(workoutsWorkspace);
      expect(call.replyTier).toBe("complex");
    });

    it("runWorkoutsReply no longer handles onboarding directly", async () => {
      const cfg = createMockConfig();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runWorkoutsReply(params);

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("fallback when workouts not in config", () => {
    it("runWorkoutsReply falls back to complex when workouts agent missing", async () => {
      const cfg = createMockConfig({
        agents: {
          defaults: { routing: { enabled: true, classifierModel: "ollama/qwen2.5:3b" } },
          list: [{ id: "main", default: true }],
        },
      });
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runWorkoutsReply(params);

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("main");
    });
  });

  describe("classifier-level onboarding", () => {
    it("intercepts workouts route when onboarding service returns a prompt", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"workouts"}' }],
        usage: { input: 10, output: 8 },
      });
      vi.mocked(maybeRunAgentOnboarding).mockResolvedValueOnce({
        text: "Before we continue, quick workouts onboarding.",
      });

      const cfg = createMockConfig();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;
      (params.ctx as { Body?: string }).Body = "log a workout";

      const result = await runAgentFlow({
        cleanedBody: "log a workout",
        sessionKey: "main",
        provider: "ollama",
        model: "qwen2.5:3b",
        defaultProvider: "ollama",
        defaultModel: "qwen2.5:3b",
        aliasIndex: {},
        cfg,
        runPreparedReplyParams: params,
      });

      expect(runPreparedReplyMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        text: expect.stringContaining("quick workouts onboarding"),
      });
    });
  });
});
