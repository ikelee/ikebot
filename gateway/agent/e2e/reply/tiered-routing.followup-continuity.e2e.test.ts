import { completeSimple } from "@mariozechner/pi-ai";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../../../test/helpers/temp-home.js";
import { runEmbeddedPiAgent } from "../../../runtime/pi-embedded.js";
import { getReplyFromConfig } from "../../pipeline/reply.js";
import { __resetOnboardingStateForTests } from "../../run.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

vi.mock("../../../runtime/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  compactEmbeddedPiSession: vi.fn(),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

vi.mock("../../onboarding/service.js", () => ({
  maybeRunAgentOnboarding: vi.fn(async () => undefined),
}));

function extractReplyText(reply: unknown): string {
  if (Array.isArray(reply)) {
    return extractReplyText(reply[0]);
  }
  if (!reply || typeof reply !== "object") {
    return "";
  }
  const text = (reply as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function cfgFor(home: string) {
  return {
    agents: {
      defaults: {
        model: "ollama/qwen2.5:14b",
        routing: { enabled: true, classifierModel: "ollama/qwen2.5:14b" },
        workspace: join(home, "openclaw"),
      },
      list: [
        { id: "main", default: true },
        {
          id: "calendar",
          workspace: join(home, "calendar"),
          skills: ["gog"],
          tools: { exec: { security: "allowlist", safeBins: ["gog"] } },
        },
      ],
    },
    channels: { webchat: { allowFrom: ["*"] } },
    models: {
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: [
            {
              id: "qwen2.5:14b",
              name: "Qwen 2.5 14B",
              api: "openai-completions",
              contextWindow: 32768,
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
    },
    session: { store: join(home, "sessions.json") },
  };
}

describe("tiered routing follow-up continuity e2e", () => {
  it("keeps confirmation routed to active specialized agent when conversation context wrapper is present", async () => {
    __resetOnboardingStateForTests();
    vi.mocked(runEmbeddedPiAgent).mockClear();
    vi.mocked(runEmbeddedPiAgent)
      .mockResolvedValueOnce({
        payloads: [
          {
            text: "Please confirm the event details. [[router_hold:acquire reason=awaiting_confirmation]]",
          },
        ],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "ollama", model: "qwen2.5:14b" },
        },
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "agent:calendar [[router_hold:release]]" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "ollama", model: "qwen2.5:14b" },
        },
      });
    vi.mocked(completeSimple).mockReset();
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: '{"decision":"calendar"}' }],
      usage: { input: 12, output: 10 },
    });

    await withTempHome(async (home) => {
      const cfg = cfgFor(home);

      const first = await getReplyFromConfig(
        {
          Body: [
            "[Thu 2026-02-19 19:05 PST] add singing lesson to my calendar for next Thursday at 445pm for an hour",
            "",
            "Conversation info (context only; reply to the user's message above—do not output this JSON):",
            "```json",
            '{ "conversation_label": "openclaw-tui" }',
            "```",
          ].join("\n"),
          From: "followup-user",
          To: "followup-user",
          Provider: "webchat",
        },
        {},
        cfg,
      );
      expect(extractReplyText(first).toLowerCase()).toContain("please confirm");

      const second = await getReplyFromConfig(
        {
          Body: [
            "[Thu 2026-02-19 19:06 PST] yes",
            "",
            "Conversation info (context only; reply to the user's message above—do not output this JSON):",
            "```json",
            '{ "conversation_label": "openclaw-tui" }',
            "```",
          ].join("\n"),
          From: "followup-user",
          To: "followup-user",
          Provider: "webchat",
        },
        {},
        cfg,
      );
      expect(extractReplyText(second)).toContain("agent:calendar");
    });

    expect(vi.mocked(runEmbeddedPiAgent)).toHaveBeenCalledTimes(2);
    // Second turn used router hold auto-route; classifier should not run.
    expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
    const secondCall = vi.mocked(runEmbeddedPiAgent).mock.calls[1]?.[0];
    expect(firstCall?.agentId).toBe("calendar");
    expect(secondCall?.agentId).toBe("calendar");
  });
});
