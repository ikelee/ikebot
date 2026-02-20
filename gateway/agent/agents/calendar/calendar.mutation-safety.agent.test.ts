import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../../../test/helpers/temp-home.js";
import { runEmbeddedPiAgent } from "../../../runtime/pi-embedded.js";
import { maybeRunAgentOnboarding } from "../../onboarding/service.js";
import { getReplyFromConfig } from "../../pipeline/reply.js";

vi.mock("../../../runtime/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

vi.mock("../../onboarding/service.js", () => ({
  maybeRunAgentOnboarding: vi.fn(async () => undefined),
}));

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      return await fn(home);
    },
    {
      env: {
        OPENCLAW_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
        PI_CODING_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
      },
      prefix: "openclaw-calendar-agent-safety-",
    },
  );
}

function extractReplyText(reply: unknown): string {
  const first = Array.isArray(reply) ? reply[0] : reply;
  if (!first || typeof first !== "object") {
    return "";
  }
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

describe("calendar agent-level mutation safety", () => {
  const falseSuccessCases = [
    {
      name: "add (exact Ani phrasing)",
      input: "Add Ani’s fundraiser for march 5th 530-730",
      modelText:
        "I've already added Ani’s fundraiser to your calendar for March 5th from 5:30 PM to 7:30 PM.\n\nHere's the event link:\n\n[Event Link](https://www.google.com/calendar/event?eid=fake)",
    },
    {
      name: "add simple",
      input: "add singing lesson to my calendar next thursday at 445pm for 1 hour weekly",
      modelText: "I've added your singing lesson for next Thursday at 4:45 PM and made it weekly.",
    },
    {
      name: "update",
      input: "update Ani's fundraiser to 6pm to 8pm on march 5",
      modelText: "I've updated Ani's fundraiser to 6:00 PM to 8:00 PM on March 5.",
    },
    {
      name: "delete",
      input: "delete Ani's fundraiser from my calendar",
      modelText: "I've deleted Ani's fundraiser from your calendar.",
    },
    {
      name: "reschedule",
      input: "reschedule Ani's fundraiser to march 6th at 530pm",
      modelText: "I've rescheduled Ani's fundraiser to March 6 at 5:30 PM.",
    },
    {
      name: "cancel",
      input: "cancel my singing lesson next thursday",
      modelText: "I've canceled your singing lesson next Thursday.",
    },
  ] as const;

  for (const testCase of falseSuccessCases) {
    it(`blocks no-tool-call false success for ${testCase.name}`, async () => {
      await withTempHome(async (home) => {
        vi.mocked(maybeRunAgentOnboarding).mockResolvedValue(undefined);
        vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce({
          payloads: [{ text: testCase.modelText }],
          meta: { toolExecutions: [] },
        });

        const reply = await getReplyFromConfig(
          {
            Body: testCase.input,
            From: "+15550001111",
            To: "+15550002222",
            Provider: "webchat",
            SessionKey: `agent:calendar:mutation-safety:${testCase.name}`,
          },
          {},
          {
            agents: {
              defaults: {
                model: "ollama/qwen2.5:14b",
                routing: { enabled: false, classifierModel: "ollama/qwen2.5:14b" },
                workspace: path.join(home, "workspace-calendar"),
              },
              list: [{ id: "calendar", default: true }],
            },
            channels: { webchat: { allowFrom: ["*"] } },
          },
        );

        const text = extractReplyText(reply).toLowerCase();
        expect(text).toContain("no event was changed");
        expect(text).toContain("not executed");
      });
    });
  }

  it("allows mutation success text when exec tool call succeeded", async () => {
    await withTempHome(async (home) => {
      vi.mocked(maybeRunAgentOnboarding).mockResolvedValue(undefined);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce({
        payloads: [{ text: "Updated successfully." }],
        meta: {
          toolExecutions: [{ toolName: "exec", isError: false }],
        },
      });

      const reply = await getReplyFromConfig(
        {
          Body: "update eventId abc123 to 4pm",
          From: "+15550001111",
          To: "+15550002222",
          Provider: "webchat",
          SessionKey: "agent:calendar:mutation-safety:exec-success",
        },
        {},
        {
          agents: {
            defaults: {
              model: "ollama/qwen2.5:14b",
              routing: { enabled: false, classifierModel: "ollama/qwen2.5:14b" },
              workspace: path.join(home, "workspace-calendar"),
            },
            list: [{ id: "calendar", default: true }],
          },
          channels: { webchat: { allowFrom: ["*"] } },
        },
      );

      const text = extractReplyText(reply).toLowerCase();
      expect(text).toContain("updated successfully");
      expect(text).not.toContain("no event was changed");
    });
  });
});
