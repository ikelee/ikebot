/**
 * Unit tests for runAgentFlow routing.
 * Mocks completeSimple (classifier) and runPreparedReply to verify calendar routing.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../infra/config/config.js";
import { maybeRunAgentOnboarding } from "./onboarding/service.js";
import { __resetOnboardingStateForTests, runAgentFlow } from "./run.js";

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
vi.mock("./onboarding/service.js", () => ({
  maybeRunAgentOnboarding: vi.fn(async () => undefined),
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
    __resetOnboardingStateForTests();
    vi.clearAllMocks();
    runPreparedReplyMock.mockResolvedValue({ text: "ok" });
    vi.mocked(maybeRunAgentOnboarding).mockResolvedValue(undefined);
  });

  it("routes through classifier first, then returns workouts onboarding", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"workouts"}' }],
      usage: { input: 10, output: 8 },
    });
    vi.mocked(maybeRunAgentOnboarding).mockResolvedValue({
      text: "Before we continue, quick workouts onboarding.",
    });

    const cfg = createMockConfig();
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;

    const result = await runAgentFlow({
      cleanedBody: "let's start logging my workouts",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    expect(result).toEqual({
      text: "Before we continue, quick workouts onboarding.",
    });
    expect(maybeRunAgentOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "workouts",
        cleanedBody: "let's start logging my workouts",
      }),
    );
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });

  it("supports explicit top-level onboarding intent for any agent", async () => {
    vi.mocked(maybeRunAgentOnboarding).mockResolvedValue({
      text: "Calendar onboarding",
    });

    const cfg = createMockConfig();
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;

    const result = await runAgentFlow({
      cleanedBody: "onboard calendar agent",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    expect(result).toEqual({ text: "Calendar onboarding" });
    expect(maybeRunAgentOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "calendar",
      }),
    );
    expect(completeSimple).not.toHaveBeenCalled();
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });

  it("keeps workouts onboarding follow-up field messages in top-level onboarding flow", async () => {
    vi.mocked(maybeRunAgentOnboarding).mockResolvedValue({
      text: "Onboarding step",
    });

    const cfg = createMockConfig();
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;

    const result = await runAgentFlow({
      cleanedBody: "style: assertive",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    expect(result).toEqual({ text: "Onboarding step" });
    expect(maybeRunAgentOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "workouts",
        cleanedBody: "style: assertive",
      }),
    );
    expect(completeSimple).not.toHaveBeenCalled();
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });

  it("keeps active onboarding pinned to the same agent across unstructured follow-ups", async () => {
    vi.mocked(maybeRunAgentOnboarding).mockImplementation(async ({ cleanedBody }) => {
      if (!cleanedBody) {
        return { text: "Before we continue, quick workouts onboarding." };
      }
      return { text: "Before we continue, quick workouts onboarding." };
    });

    const cfg = createMockConfig();
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;

    const first = await runAgentFlow({
      cleanedBody: "style: assertive",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });
    expect(first).toEqual({ text: "Before we continue, quick workouts onboarding." });

    const second = await runAgentFlow({
      cleanedBody: "supportive",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });
    expect(second).toEqual({ text: "Before we continue, quick workouts onboarding." });

    expect(maybeRunAgentOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "workouts",
        cleanedBody: "supportive",
      }),
    );
    expect(completeSimple).not.toHaveBeenCalled();
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
  });

  it("clears active onboarding after completion and resumes normal routing", async () => {
    let completed = false;
    vi.mocked(maybeRunAgentOnboarding).mockImplementation(async ({ cleanedBody }) => {
      if (cleanedBody === "style: assertive") {
        return { text: "Before we continue, quick workouts onboarding." };
      }
      if (cleanedBody === "supportive") {
        completed = true;
        return { text: "Onboarding saved." };
      }
      if (!cleanedBody) {
        return completed ? undefined : { text: "Before we continue, quick workouts onboarding." };
      }
      return undefined;
    });

    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"calendar"}' }],
      usage: { input: 10, output: 8 },
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
      cleanedBody: "style: assertive",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    const completion = await runAgentFlow({
      cleanedBody: "supportive",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });
    expect(completion).toEqual({ text: "Onboarding saved." });

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

    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
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

  it("injects deterministic next-weekday date hints for calendar prompts", async () => {
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
      cleanedBody:
        "[Thu 2026-02-19 22:48 PST] add singing lesson to my calendar, it's at 445pm next thursday for an hour",
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
    const bodyForAgent = String(call.sessionCtx?.BodyForAgent ?? "");
    expect(bodyForAgent).toContain("Calendar date hints (deterministic)");
    expect(bodyForAgent).toContain("next thursday = 2026-02-26");
    expect(bodyForAgent).toContain(
      "next thursday at 4:45pm local = 2026-02-26T16:45:00-08:00 (UTC 2026-02-27T00:45:00Z)",
    );
    expect(bodyForAgent).toContain(
      "next thursday execution UTC window: --from 2026-02-27T00:45:00Z --to 2026-02-27T01:45:00Z",
    );
    expect(bodyForAgent).toContain(
      "Execution rule: for calendar create/update commands, use the exact UTC --from/--to window above; do not reinterpret timezone.",
    );
  });

  it("injects deterministic absolute-date hints for calendar prompts", async () => {
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
      cleanedBody: "[Fri 2026-02-20 12:30 PST] Add Ani's fundraiser for march 5th 530-730",
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
    const bodyForAgent = String(call.sessionCtx?.BodyForAgent ?? "");
    expect(bodyForAgent).toContain("Calendar date hints (deterministic)");
    expect(bodyForAgent).toContain("march 5th = 2026-03-05");
    expect(bodyForAgent).toContain(
      "march 5th at 5:30pm (assumed) local = 2026-03-05T17:30:00-08:00 (UTC 2026-03-06T01:30:00Z)",
    );
    expect(bodyForAgent).toContain(
      "march 5th execution UTC window: --from 2026-03-06T01:30:00Z --to 2026-03-06T03:30:00Z",
    );
  });

  it("injects deterministic date hints even when classifier routes to complex", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"escalate"}' }],
      usage: { input: 10, output: 8 },
    });

    const cfg = createMockConfig({
      agents: {
        defaults: { routing: { enabled: true, classifierModel: "ollama/llama-3.2-3b" } },
        list: [{ id: "main", default: true }],
      },
    });
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;

    await runAgentFlow({
      cleanedBody:
        "[Thu 2026-02-19 22:48 PST] add singing lesson to my calendar, it's at 445pm next thursday for an hour",
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
    const bodyForAgent = String(call.sessionCtx?.BodyForAgent ?? "");
    expect(call.agentId).toBe("main");
    expect(bodyForAgent).toContain("Calendar date hints (deterministic)");
    expect(bodyForAgent).toContain("next thursday = 2026-02-26");
  });

  it("keeps short confirmation follow-ups on calendar after a calendar turn", async () => {
    vi.mocked(completeSimple)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"calendar"}' }],
        usage: { input: 10, output: 8 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"stay"}' }],
        usage: { input: 8, output: 6 },
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
      cleanedBody: "schedule singing lesson thursday at 4:45pm",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    await runAgentFlow({
      cleanedBody: "yes do it",
      sessionKey: "main",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
    });

    expect(runPreparedReplyMock).toHaveBeenCalledTimes(2);
    const secondCall = runPreparedReplyMock.mock.calls[1][0];
    expect(secondCall.agentId).toBe("calendar");
  });

  it("keeps confirmation follow-ups on calendar even if session key changes", async () => {
    vi.mocked(completeSimple)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"calendar"}' }],
        usage: { input: 10, output: 8 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"stay"}' }],
        usage: { input: 8, output: 6 },
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
      cleanedBody: "schedule singing lesson thursday at 4:45pm",
      sessionKey: "session-a",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });

    await runAgentFlow({
      cleanedBody: "yes",
      sessionKey: "session-b",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });

    expect(runPreparedReplyMock).toHaveBeenCalledTimes(2);
    const secondCall = runPreparedReplyMock.mock.calls[1][0];
    expect(secondCall.agentId).toBe("calendar");
  });

  it("keeps calendar follow-ups when confirmation contains wrapped conversation context", async () => {
    vi.mocked(completeSimple)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"calendar"}' }],
        usage: { input: 10, output: 8 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"stay"}' }],
        usage: { input: 8, output: 6 },
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
      cleanedBody:
        "[Thu 2026-02-19 19:05 PST] add singing lesson to my calendar for next Thursday at 445pm",
      sessionKey: "openclaw-tui",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });

    await runAgentFlow({
      cleanedBody: [
        "[Thu 2026-02-19 19:06 PST] yes",
        "",
        "Conversation info (context only; reply to the user's message above—do not output this JSON):",
        "```json",
        '{ "conversation_label": "openclaw-tui" }',
        "```",
      ].join("\n"),
      sessionKey: "openclaw-tui",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });

    expect(runPreparedReplyMock).toHaveBeenCalledTimes(2);
    const secondCall = runPreparedReplyMock.mock.calls[1][0];
    expect(secondCall.agentId).toBe("calendar");
  });

  it("auto-routes while router hold is active and resumes classifier after release", async () => {
    vi.mocked(completeSimple)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"calendar"}' }],
        usage: { input: 10, output: 8 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"stay"}' }],
        usage: { input: 8, output: 6 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "thanks" }],
        usage: { input: 8, output: 6 },
      });

    runPreparedReplyMock
      .mockResolvedValueOnce({
        text: "Is the singing lesson next Thursday at 4:45 PM for one hour and recurring weekly? [[router_hold:acquire reason=awaiting_confirmation]]",
      })
      .mockResolvedValueOnce({
        text: "Done, recurring event created. [[router_hold:release]]",
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

    const first = await runAgentFlow({
      cleanedBody: "add singing lesson next thursday at 4:45pm",
      sessionKey: "openclaw-tui",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });
    expect((first as { text?: string }).text).not.toContain("[[router_hold:");

    await runAgentFlow({
      cleanedBody: "yes",
      sessionKey: "openclaw-tui",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });

    await runAgentFlow({
      cleanedBody: "thanks",
      sessionKey: "openclaw-tui",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });

    // First turn classifier + third turn classifier. Second turn should bypass due to hold.
    expect(completeSimple).toHaveBeenCalledTimes(3);
    expect(runPreparedReplyMock).toHaveBeenCalledTimes(2);
    const firstCall = runPreparedReplyMock.mock.calls[0][0];
    const secondCall = runPreparedReplyMock.mock.calls[1][0];
    expect(firstCall.agentId).toBe("calendar");
    expect(secondCall.agentId).toBe("calendar");
    expect(String(secondCall.sessionCtx?.BodyForAgent ?? "")).toContain(
      "Router confirmation fast-path: user confirmed the pending calendar action.",
    );
  });

  it("supports explicit handoff queue from calendar to mail", async () => {
    vi.mocked(completeSimple)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"calendar"}' }],
        usage: { input: 10, output: 8 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"stay"}' }],
        usage: { input: 8, output: 6 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "thanks" }],
        usage: { input: 8, output: 6 },
      });

    runPreparedReplyMock
      .mockResolvedValueOnce({
        text: "I found two invites. Which one should I use? [[router_hold:acquire reason=calendar_disambiguation]]",
      })
      .mockResolvedValueOnce({
        text: "Great, now I'll draft and send the email. [[router_hold:release]] [[router_handoff:mail]]",
      })
      .mockResolvedValueOnce({
        text: "Sent from your selected account. [[router_hold:release]]",
      });

    const cfg = createMockConfig({
      agents: {
        defaults: { routing: { enabled: true, classifierModel: "ollama/llama-3.2-3b" } },
        list: [
          { id: "main", default: true },
          { id: "calendar", skills: ["gog"], tools: { exec: { safeBins: ["gog"] } } },
          { id: "mail", skills: ["gog"], tools: { exec: { safeBins: ["gog"] } } },
        ],
      },
    });
    const params = createMinimalRunPreparedReplyParams();
    params.cfg = cfg;

    await runAgentFlow({
      cleanedBody: "send an email to my 4 o clock meeting next Tuesday",
      sessionKey: "openclaw-tui",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });

    await runAgentFlow({
      cleanedBody: "the second meeting",
      sessionKey: "openclaw-tui",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });

    await runAgentFlow({
      cleanedBody: "use my work account",
      sessionKey: "openclaw-tui",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });

    await runAgentFlow({
      cleanedBody: "thanks",
      sessionKey: "openclaw-tui",
      provider: "ollama",
      model: "llama-3.2-3b",
      defaultProvider: "ollama",
      defaultModel: "llama-3.2-3b",
      aliasIndex: {},
      cfg,
      runPreparedReplyParams: params,
      userIdentifier: "same-user",
    });

    // completeSimple includes router + SimpleResponder model calls.
    // Expected: first router, final router, final SimpleResponder.
    expect(completeSimple).toHaveBeenCalledTimes(3);
    expect(runPreparedReplyMock).toHaveBeenCalledTimes(3);
    expect(runPreparedReplyMock.mock.calls[0][0].agentId).toBe("calendar");
    expect(runPreparedReplyMock.mock.calls[1][0].agentId).toBe("calendar");
    expect(runPreparedReplyMock.mock.calls[2][0].agentId).toBe("mail");
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
