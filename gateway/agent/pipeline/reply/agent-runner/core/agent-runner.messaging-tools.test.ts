import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../../../templating.js";
import type { FollowupRun, QueueSettings } from "../queue.js";
import {
  loadSessionStore,
  saveSessionStore,
  type SessionEntry,
} from "../../../../../infra/config/sessions.js";
import { createMockTypingController } from "../../utilities/test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../../../../../runtime/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
  }),
}));

vi.mock("../../../../../runtime/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../queue.js", async () => {
  const actual = await vi.importActual<typeof import("../queue.js")>("../queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

function createRun(
  messageProvider = "slack",
  opts: { storePath?: string; sessionKey?: string; agentId?: string } = {},
) {
  const typing = createMockTypingController();
  const sessionKey = opts.sessionKey ?? "main";
  const sessionCtx = {
    Provider: messageProvider,
    OriginatingTo: "channel:C1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      agentId: opts.agentId,
    },
  } as unknown as FollowupRun;

  return runReplyAgent({
    commandBody: "hello",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing,
    sessionCtx,
    sessionKey,
    storePath: opts.storePath,
    defaultModel: "anthropic/claude-opus-4-5",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
}

describe("runReplyAgent messaging tool suppression", () => {
  it("blocks calendar success claims when no successful exec tool call occurred", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'm adding your singing lesson for next Thursday at 4:45 PM." }],
      meta: {
        toolExecutions: [{ toolName: "exec", isError: true }],
      },
    });

    const result = await createRun("webchat", { agentId: "calendar" });

    expect(result).toMatchObject({
      isError: true,
    });
    expect((result as { text?: string }).text).toContain("no event was changed");
  });

  it("blocks calendar past-tense success claims when no successful exec tool call occurred", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [
        {
          text: "I've added Ani’s fundraiser to your calendar for March 5th from 5:30 PM to 7:30 PM.",
        },
      ],
      meta: {
        toolExecutions: [],
      },
    });

    const result = await createRun("webchat", { agentId: "calendar" });

    expect(result).toMatchObject({
      isError: true,
    });
    expect((result as { text?: string }).text).toContain("no event was changed");
  });

  it("blocks calendar 'already added' success claims with event links when no successful exec tool call occurred", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [
        {
          text: "I've already added Ani’s fundraiser to your calendar for March 5th from 5:30 PM to 7:30 PM.\n\nHere's the event link:\n\n[Event Link](https://www.google.com/calendar/event?eid=fake)",
        },
      ],
      meta: {
        toolExecutions: [],
      },
    });

    const result = await createRun("webchat", { agentId: "calendar" });

    expect(result).toMatchObject({
      isError: true,
    });
    expect((result as { text?: string }).text).toContain("no event was changed");
  });

  it("blocks non-clarifying calendar mutation replies when no successful exec occurred", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [
        { text: "Done. Here is your event link: https://www.google.com/calendar/event?eid=fake" },
      ],
      meta: {
        toolExecutions: [],
      },
    });

    const result = await runReplyAgent({
      commandBody: "Add Ani's fundraiser for march 5th 530-730",
      followupRun: {
        prompt: "hello",
        summaryLine: "hello",
        enqueuedAt: Date.now(),
        run: {
          sessionId: "session",
          sessionKey: "main",
          messageProvider: "webchat",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp",
          config: {},
          skillsSnapshot: {},
          provider: "anthropic",
          model: "claude",
          thinkLevel: "low",
          verboseLevel: "off",
          elevatedLevel: "off",
          bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
          timeoutMs: 1_000,
          blockReplyBreak: "message_end",
          agentId: "calendar",
        },
      } as unknown as FollowupRun,
      queueKey: "main",
      resolvedQueue: { mode: "interrupt" } as unknown as QueueSettings,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing: createMockTypingController(),
      sessionCtx: {
        Provider: "webchat",
        OriginatingTo: "channel:C1",
        AccountId: "primary",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    expect(result).toMatchObject({ isError: true });
    expect((result as { text?: string }).text).toContain("no event was changed");
  });

  it("keeps calendar success claims when exec tool call succeeded", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Your event was created." }],
      meta: {
        toolExecutions: [{ toolName: "exec", isError: false }],
      },
    });

    const result = await createRun("webchat", { agentId: "calendar" });

    expect(result).toMatchObject({ text: "Your event was created." });
  });

  it("drops replies when a messaging tool sent via the same provider + target", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toBeUndefined();
  });

  it("delivers replies when tool provider does not match", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });

  it("delivers replies when account ids do not match", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          accountId: "alt",
        },
      ],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });

  it("persists usage fields even when replies are suppressed", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const entry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    await saveSessionStore(storePath, { [sessionKey]: entry });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const result = await createRun("slack", { storePath, sessionKey });

    expect(result).toBeUndefined();
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.inputTokens).toBe(10);
    expect(store[sessionKey]?.outputTokens).toBe(5);
    expect(store[sessionKey]?.totalTokens).toBeUndefined();
    expect(store[sessionKey]?.totalTokensFresh).toBe(false);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
  });

  it("persists totalTokens from promptTokens when snapshot is available", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const entry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    await saveSessionStore(storePath, { [sessionKey]: entry });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          promptTokens: 42_000,
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const result = await createRun("slack", { storePath, sessionKey });

    expect(result).toBeUndefined();
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.totalTokens).toBe(42_000);
    expect(store[sessionKey]?.totalTokensFresh).toBe(true);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
  });
});
