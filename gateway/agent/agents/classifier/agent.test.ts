/**
 * Unit tests for RouterAgent (Phase 1 classifier).
 * Mocks completeSimple to avoid real LLM calls.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgent } from "../../core/agent-executor.js";
import { resolveCompleteSimpleApiKey } from "../llm-auth.js";
import { RouterAgent } from "./agent.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));
vi.mock("../llm-auth.js", async () => {
  const actual = await vi.importActual<typeof import("../llm-auth.js")>("../llm-auth.js");
  return {
    ...actual,
    resolveCompleteSimpleApiKey: vi.fn(async () => "test-api-key"),
  };
});

const createMockModel = () =>
  ({
    provider: "ollama",
    id: "test-model",
    api: "openai-completions",
  }) as any;

describe("RouterAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveCompleteSimpleApiKey).mockResolvedValue("test-api-key");
  });

  it("returns stay for basic commands without model", async () => {
    const modelResolver = vi.fn().mockResolvedValue(undefined);
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "/status" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("stay");
    expect(modelResolver).not.toHaveBeenCalled();
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("returns escalate for /reset and /new without model", async () => {
    const modelResolver = vi.fn().mockResolvedValue(undefined);
    const agent = new RouterAgent(modelResolver);

    for (const cmd of ["/reset", "/new"]) {
      const output = await executeAgent(
        agent,
        { userIdentifier: "user", message: cmd },
        { recordTrace: false },
      );
      expect(output.decision).toBe("escalate");
    }
  });

  it("returns escalate when no classifier model", async () => {
    const modelResolver = vi.fn().mockResolvedValue(undefined);
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "run this script" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("escalate");
    expect(modelResolver).toHaveBeenCalled();
  });

  it("returns stay when model returns stay", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"stay"}' }],
      usage: { input: 10, output: 5 },
    });

    const modelResolver = vi.fn().mockResolvedValue(createMockModel());
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "hello" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("stay");
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(resolveCompleteSimpleApiKey).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeSimple).mock.calls[0]?.[2]).toMatchObject({
      apiKey: "test-api-key",
    });
  });

  it("parses output_text content blocks used by codex/openai responses", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "output_text", text: '{"decision":"calendar"}' }],
      usage: { input: 10, output: 5 },
    } as any);

    const modelResolver = vi.fn().mockResolvedValue(createMockModel());
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "what is on my calendar?" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("calendar");
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("returns escalate when model returns escalate", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"escalate"}' }],
      usage: { input: 10, output: 8 },
    });

    const modelResolver = vi.fn().mockResolvedValue(createMockModel());
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "run this bash script" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("escalate");
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("returns calendar when model returns calendar", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"calendar"}' }],
      usage: { input: 15, output: 10 },
    });

    const modelResolver = vi.fn().mockResolvedValue(createMockModel());
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "what's on my calendar today" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("calendar");
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("returns multi when model returns multi", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: '{"decision":"multi"}' }],
      usage: { input: 20, output: 8 },
    });

    const modelResolver = vi.fn().mockResolvedValue(createMockModel());
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "what do I need to hit tomorrow at the gym?" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("multi");
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it("falls back to keyword extraction when JSON parse fails", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: 'The decision is "calendar" for this request.' }],
      usage: { input: 20, output: 12 },
    });

    const modelResolver = vi.fn().mockResolvedValue(createMockModel());
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "schedule a meeting tomorrow" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("calendar");
  });

  it("defaults to escalate when response is unparseable", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "I'm not sure what you mean" }],
      usage: { input: 10, output: 6 },
    });

    const modelResolver = vi.fn().mockResolvedValue(createMockModel());
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "asdfgh" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("escalate");
  });

  it("falls back to deterministic calendar routing when model output is empty", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [],
      usage: { input: 10, output: 0 },
      stopReason: "error",
      errorMessage: "transient upstream issue",
    } as any);

    const modelResolver = vi.fn().mockResolvedValue(createMockModel());
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "Add Sam smith concert tomorrow at 7pm" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("calendar");
  });

  it("falls back to deterministic calendar routing for calendar queries when model output is empty", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [],
      usage: { input: 10, output: 0 },
      stopReason: "error",
      errorMessage: "transient upstream issue",
    } as any);

    const modelResolver = vi.fn().mockResolvedValue(createMockModel());
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "what is on my calendar tomorrow?" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("calendar");
  });

  it("falls back to deterministic calendar routing for implicit time scheduling when model output is empty", async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      content: [],
      usage: { input: 10, output: 0 },
      stopReason: "error",
      errorMessage: "transient upstream issue",
    } as any);

    const modelResolver = vi.fn().mockResolvedValue(createMockModel());
    const agent = new RouterAgent(modelResolver);

    const output = await executeAgent(
      agent,
      { userIdentifier: "user", message: "Sam smith concert tomorrow 7pm" },
      { recordTrace: false },
    );

    expect(output.decision).toBe("calendar");
  });
});
