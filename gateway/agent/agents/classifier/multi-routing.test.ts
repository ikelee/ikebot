/**
 * Multi-agent and cross-domain routing tests.
 *
 * Tests classifier decision matrix for multi vs single-domain routing.
 * Mocks completeSimple to simulate model responses; validates routing logic.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgent } from "../../core/agent-executor.js";
import { RouterAgent } from "./agent.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

const createMockModel = () =>
  ({
    provider: "ollama",
    id: "test-model",
    api: "openai-completions",
  }) as any;

type Decision =
  | "stay"
  | "escalate"
  | "calendar"
  | "reminders"
  | "mail"
  | "workouts"
  | "finance"
  | "multi";

function mockDecision(decision: Decision) {
  vi.mocked(completeSimple).mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify({ decision }) }],
    usage: { input: 20, output: 10 },
  });
}

function mockDecisionWithAgents(decision: Decision, agents?: string[]) {
  vi.mocked(completeSimple).mockResolvedValue({
    content: [
      {
        type: "text",
        text: JSON.stringify(agents ? { decision, agents } : { decision }),
      },
    ],
    usage: { input: 20, output: 10 },
  });
}

describe("RouterAgent multi and cross-domain routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("multi: calendar + workouts blends", () => {
    const cases: Array<{ message: string; expected: Decision }> = [
      {
        message: "What do I need to hit tomorrow at the gym?",
        expected: "multi",
      },
      {
        message: "What workout fits my schedule tomorrow evening?",
        expected: "multi",
      },
    ];

    for (const { message, expected } of cases) {
      it(`routes "${message.slice(0, 50)}..." to ${expected}`, async () => {
        mockDecision(expected);
        const modelResolver = vi.fn().mockResolvedValue(createMockModel());
        const agent = new RouterAgent(modelResolver);

        const output = await executeAgent(
          agent,
          { userIdentifier: "user", message },
          { recordTrace: false },
        );

        expect(output.decision).toBe(expected);
        expect(completeSimple).toHaveBeenCalledTimes(1);
      });
    }
  });

  describe("multi: finance + calendar blends", () => {
    const cases: Array<{ message: string; expected: Decision; agents?: string[] }> = [
      {
        message: "Can I afford to buy gym equipment given my budget and schedule this week?",
        expected: "multi",
        agents: ["finance", "calendar"],
      },
      {
        message: "Should I spend $200 on a treadmill? Check my budget and when I'm free to use it.",
        expected: "multi",
        agents: ["finance", "calendar"],
      },
    ];

    for (const { message, expected, agents } of cases) {
      it(`routes "${message.slice(0, 50)}..." to ${expected} with agents`, async () => {
        mockDecisionWithAgents(expected, agents);
        const modelResolver = vi.fn().mockResolvedValue(createMockModel());
        const agent = new RouterAgent(modelResolver);

        const output = await executeAgent(
          agent,
          { userIdentifier: "user", message },
          { recordTrace: false },
        );

        expect(output.decision).toBe(expected);
        expect(output.agents).toEqual(agents);
        expect(completeSimple).toHaveBeenCalledTimes(1);
      });
    }
  });

  describe("fake multis: single-domain despite mixed keywords", () => {
    const cases: Array<{ message: string; expected: Decision; reason: string }> = [
      {
        message: "Check email for workout supplement deals I got",
        expected: "mail",
        reason: "primary intent is email, workout is just context",
      },
      {
        message: "Do I have any supplement discounts in the mail recently?",
        expected: "mail",
        reason: "email search for discounts, supplement is search term",
      },
      {
        message: "Search my inbox for gym membership confirmation",
        expected: "mail",
        reason: "email search, gym is just search term",
      },
      {
        message: "How much did I spend on gym last month?",
        expected: "finance",
        reason: "spending query, gym is category not workout tracking",
      },
      {
        message: "Log a purchase of $50 for protein powder",
        expected: "finance",
        reason: "purchase logging, supplement is product not workout",
      },
      {
        message: "What's on my calendar for my workout with John?",
        expected: "calendar",
        reason: "calendar query, workout is event context",
      },
      {
        message: "Schedule a meeting to discuss my fitness goals",
        expected: "calendar",
        reason: "scheduling, fitness is topic not workout tracking",
      },
      {
        message: "Remind me to take my pre-workout before the gym",
        expected: "reminders",
        reason: "reminder, gym is timing context",
      },
      {
        message: "What did I bench last week?",
        expected: "workouts",
        reason: "workout history only, no calendar",
      },
      {
        message: "Log my chest workout from today",
        expected: "workouts",
        reason: "workout logging only",
      },
    ];

    for (const { message, expected, reason } of cases) {
      it(`routes "${message.slice(0, 45)}..." to ${expected} (${reason})`, async () => {
        mockDecision(expected);
        const modelResolver = vi.fn().mockResolvedValue(createMockModel());
        const agent = new RouterAgent(modelResolver);

        const output = await executeAgent(
          agent,
          { userIdentifier: "user", message },
          { recordTrace: false },
        );

        expect(output.decision).toBe(expected);
        expect(output.decision).not.toBe("multi");
        expect(completeSimple).toHaveBeenCalledTimes(1);
      });
    }
  });

  describe("multi-domain: reminders + finance", () => {
    const cases: Array<{ message: string; expected: Decision; agents?: string[]; reason: string }> =
      [
        {
          message:
            "How much did I spend this month so far? Set a reminder to pay off my credit cards",
          expected: "multi",
          agents: ["finance", "reminders"],
          reason: "both finance and reminders",
        },
      ];

    for (const { message, expected, agents, reason } of cases) {
      it(`routes "${message.slice(0, 45)}..." to ${expected} (${reason})`, async () => {
        mockDecisionWithAgents(expected, agents);
        const modelResolver = vi.fn().mockResolvedValue(createMockModel());
        const agent = new RouterAgent(modelResolver);

        const output = await executeAgent(
          agent,
          { userIdentifier: "user", message },
          { recordTrace: false },
        );

        expect(output.decision).toBe(expected);
        expect(output.agents).toEqual(agents);
        expect(completeSimple).toHaveBeenCalledTimes(1);
      });
    }
  });

  describe("keyword fallback when JSON parse fails", () => {
    it("extracts multi from prose response", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [
          {
            type: "text",
            text: 'This query needs both calendar and workouts. Decision: "multi".',
          },
        ],
        usage: { input: 25, output: 15 },
      });

      const modelResolver = vi.fn().mockResolvedValue(createMockModel());
      const agent = new RouterAgent(modelResolver);

      const output = await executeAgent(
        agent,
        {
          userIdentifier: "user",
          message: "what do I need to hit tomorrow at the gym?",
        },
        { recordTrace: false },
      );

      expect(output.decision).toBe("multi");
    });

    it("extracts mail from prose when multi would be wrong", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [
          {
            type: "text",
            text: 'User wants to check email for workout deals. Decision is "mail".',
          },
        ],
        usage: { input: 30, output: 12 },
      });

      const modelResolver = vi.fn().mockResolvedValue(createMockModel());
      const agent = new RouterAgent(modelResolver);

      const output = await executeAgent(
        agent,
        {
          userIdentifier: "user",
          message: "Check email for workout supplement deals I got",
        },
        { recordTrace: false },
      );

      expect(output.decision).toBe("mail");
    });
  });
});
