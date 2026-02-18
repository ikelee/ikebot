/**
 * Unit tests for runAgentFlow routing.
 * Mocks completeSimple (classifier) and runPreparedReply to verify calendar routing.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../infra/config/config.js";
import { runAgentFlow } from "./run.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

const runPreparedReplyMock = vi.fn();

const mockModel = { provider: "ollama", id: "qwen2.5:3b", api: "openai-completions" };
vi.mock("../runtime/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn(() => ({ model: mockModel })),
}));

vi.mock("../runtime/agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
}));
vi.mock("./pipeline/reply/reply-building/get-reply-run.js", () => ({
  runPreparedReply: (...args: unknown[]) => runPreparedReplyMock(...args),
}));

const createMockConfig = (overrides?: Partial<OpenClawConfig>): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        routing: {
          enabled: true,
          classifierModel: "ollama/qwen2.5:3b",
        },
      },
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
  commandSource: "chat",
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

describe("runAgentFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runPreparedReplyMock.mockResolvedValue({ text: "ok" });
  });

  it("routes calendar prompts to calendar agent", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"calendar"}' }],
      usage: { input: 10, output: 8 },
    });

    const cfg = createMockConfig({
      agents: {
        defaults: { routing: { enabled: true, classifierModel: "ollama/llama-3.2-3b" } },
        list: [
          { id: "main", default: true },
          {
            id: "calendar",
            skills: ["gog"],
            tools: { exec: { safeBins: ["gog"] } },
            pi: { preset: "exec-only" },
          },
        ],
      },
    });
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;

    await runAgentFlow({
      cleanedBody: "what's on my calendar today",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
    const call = runPreparedReplyMock.mock.calls[0][0];
    expect(call.agentId).toBe("calendar");
    expect(call.agentDir).toContain("calendar");
    expect(call.agentDir).toContain("agent");
  });

  it("routes escalate prompts to main agent", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"escalate"}' }],
      usage: { input: 10, output: 8 },
    });

    const cfg = createMockConfig();
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;
    params.agentId = "main";
    params.agentDir = "/tmp/agents/main/agent";

    await runAgentFlow({
      cleanedBody: "run this script",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
    const call = runPreparedReplyMock.mock.calls[0][0];
    expect(call.agentId).toBe("main");
    expect(call.agentDir).toBe("/tmp/agents/main/agent");
  });

  it("routes schedule-add prompts to calendar agent", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"calendar"}' }],
      usage: { input: 12, output: 10 },
    });

    const cfg = createMockConfig({
      agents: {
        defaults: { routing: { enabled: true, classifierModel: "ollama/llama-3.2-3b" } },
        list: [
          { id: "main", default: true },
          { id: "calendar", skills: ["gog"], tools: { exec: { safeBins: ["gog"] } } },
        ],
      },
    });
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;

    await runAgentFlow({
      cleanedBody: "schedule a meeting with John tomorrow at 2pm",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
    const call = runPreparedReplyMock.mock.calls[0][0];
    expect(call.agentId).toBe("calendar");
  });

  it("routes modify-schedule prompts to calendar agent", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"calendar"}' }],
      usage: { input: 14, output: 10 },
    });

    const cfg = createMockConfig({
      agents: {
        defaults: { routing: { enabled: true, classifierModel: "ollama/llama-3.2-3b" } },
        list: [
          { id: "main", default: true },
          { id: "calendar", skills: ["gog"], tools: { exec: { safeBins: ["gog"] } } },
        ],
      },
    });
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;

    await runAgentFlow({
      cleanedBody: "move my 3pm meeting to 4pm",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
    const call = runPreparedReplyMock.mock.calls[0][0];
    expect(call.agentId).toBe("calendar");
  });

  it("emits routing event with tier=calendar for calendar prompts", async () => {
    const emitSpy = vi.spyOn(await import("../infra/agent-events.js"), "emitAgentEvent");

    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"calendar"}' }],
      usage: { input: 10, output: 8 },
    });

    const cfg = createMockConfig();
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;

    await runAgentFlow({
      cleanedBody: "add team standup to my calendar every Monday 9am",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    const routingCall = emitSpy.mock.calls.find((c) => c[0]?.stream === "routing");
    expect(routingCall).toBeDefined();
    expect(routingCall?.[0]?.data?.tier).toBe("calendar");
    expect(routingCall?.[0]?.data?.decision).toBe("calendar");

    emitSpy.mockRestore();
  });

  describe("multi and cross-domain routing", () => {
    const createConfigWithAllAgents = () =>
      createMockConfig({
        agents: {
          defaults: { routing: { enabled: true, classifierModel: "ollama/llama-3.2-3b" } },
          list: [
            { id: "main", default: true },
            { id: "calendar", skills: ["gog"], tools: { exec: { safeBins: ["gog"] } } },
            { id: "mail", skills: ["gog"], tools: { exec: { safeBins: ["gog"] } } },
            { id: "workouts", skills: [], tools: {} },
            { id: "finance", skills: [], tools: {} },
            {
              id: "multi",
              skills: [],
              tools: {},
              subagents: { allowAgents: ["calendar", "workouts", "finance", "reminders"] },
            },
          ],
        },
      });

    it("routes multi (calendar+workouts) prompts to multi agent", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"multi"}' }],
        usage: { input: 20, output: 8 },
      });

      const cfg = createConfigWithAllAgents();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody: "what do I need to hit tomorrow at the gym?",
        sessionKey: "main",
        provider: "ollama",
        model: "llama-3.2-3b",
        defaultProvider: "ollama",
        defaultModel: "llama-3.2-3b",
        aliasIndex: {},
        cfg,
        runPreparedReplyParams: params,
      });

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("multi");
      expect(call.agentDir).toContain("multi");
    });

    it("routes fake multi (email + workout keyword) to mail agent", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"mail"}' }],
        usage: { input: 25, output: 8 },
      });

      const cfg = createConfigWithAllAgents();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody: "Check email for workout supplement deals I got",
        sessionKey: "main",
        provider: "ollama",
        model: "llama-3.2-3b",
        defaultProvider: "ollama",
        defaultModel: "llama-3.2-3b",
        aliasIndex: {},
        cfg,
        runPreparedReplyParams: params,
      });

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("mail");
      expect(call.agentId).not.toBe("multi");
    });

    it("routes supplement discounts in mail to mail agent (not multi)", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"mail"}' }],
        usage: { input: 25, output: 8 },
      });

      const cfg = createConfigWithAllAgents();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody: "Do I have any supplement discounts in the mail recently?",
        sessionKey: "main",
        provider: "ollama",
        model: "llama-3.2-3b",
        defaultProvider: "ollama",
        defaultModel: "llama-3.2-3b",
        aliasIndex: {},
        cfg,
        runPreparedReplyParams: params,
      });

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("mail");
      expect(call.agentId).not.toBe("multi");
    });

    it("routes finance+workout keyword (spending) to finance agent", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"finance"}' }],
        usage: { input: 20, output: 8 },
      });

      const cfg = createConfigWithAllAgents();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody: "How much did I spend on gym last month?",
        sessionKey: "main",
        provider: "ollama",
        model: "llama-3.2-3b",
        defaultProvider: "ollama",
        defaultModel: "llama-3.2-3b",
        aliasIndex: {},
        cfg,
        runPreparedReplyParams: params,
      });

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("finance");
      expect(call.agentId).not.toBe("multi");
    });

    it("routes workout + schedule to multi agent", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"multi"}' }],
        usage: { input: 25, output: 8 },
      });

      const cfg = createConfigWithAllAgents();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody: "What workout fits my schedule tomorrow evening?",
        sessionKey: "main",
        provider: "ollama",
        model: "llama-3.2-3b",
        defaultProvider: "ollama",
        defaultModel: "llama-3.2-3b",
        aliasIndex: {},
        cfg,
        runPreparedReplyParams: params,
      });

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("multi");
    });

    it("routes reminders+finance (multi-domain) to multi agent with orchestrateAgents", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"decision":"multi","agents":["finance","reminders"]}',
          },
        ],
        usage: { input: 30, output: 8 },
      });

      const cfg = createConfigWithAllAgents();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody:
          "How much did I spend this month so far? Set a reminder to pay off my credit cards",
        sessionKey: "main",
        provider: "ollama",
        model: "llama-3.2-3b",
        defaultProvider: "ollama",
        defaultModel: "llama-3.2-3b",
        aliasIndex: {},
        cfg,
        runPreparedReplyParams: params,
      });

      expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
      const call = runPreparedReplyMock.mock.calls[0][0];
      expect(call.agentId).toBe("multi");
      expect(call.orchestrateAgents).toEqual(["finance", "reminders"]);
    });

    it("emits routing event with tier=multi for multi prompts", async () => {
      const emitSpy = vi.spyOn(await import("../infra/agent-events.js"), "emitAgentEvent");

      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: '{"decision":"multi"}' }],
        usage: { input: 20, output: 8 },
      });

      const cfg = createConfigWithAllAgents();
      const params = createMinimalRunPreparedReplyParams();
      params.cfg = cfg;

      await runAgentFlow({
        cleanedBody: "what workout fits my schedule tomorrow?",
        sessionKey: "main",
        provider: "ollama",
        model: "llama-3.2-3b",
        defaultProvider: "ollama",
        defaultModel: "llama-3.2-3b",
        aliasIndex: {},
        cfg,
        runPreparedReplyParams: params,
      });

      const routingCall = emitSpy.mock.calls.find((c) => c[0]?.stream === "routing");
      expect(routingCall).toBeDefined();
      expect(routingCall?.[0]?.data?.tier).toBe("multi");
      expect(routingCall?.[0]?.data?.decision).toBe("multi");

      emitSpy.mockRestore();
    });
  });
});
