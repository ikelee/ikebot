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

const mockModel = { provider: "ollama", id: "llama-3.2-3b", api: "openai-completions" };
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
          classifierModel: "ollama/llama-3.2-3b",
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
              id: "llama-3.2-3b",
              name: "Llama",
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
  model: "llama-3.2-3b",
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

    const cfg = createMockConfig();
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

    const cfg = createMockConfig();
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

    const cfg = createMockConfig();
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
});
