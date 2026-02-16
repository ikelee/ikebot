import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { executeAgent } from "../core/agent-executor.js";
import {
  getGlobalAgentRegistry,
  AgentRegistry,
  setGlobalAgentRegistry,
} from "../core/agent-registry.js";
import { SimpleResponderAgent } from "./simple-responder.js";

const mockCompleteSimple = vi.fn().mockResolvedValue({
  content: [{ type: "text" as const, text: "Hello! How can I help you today?" }],
  usage: { input: 50, output: 10 },
});

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: (...args: unknown[]) => mockCompleteSimple(...args),
  streamSimple: vi.fn(),
}));

const mockResolveModel = vi.fn().mockReturnValue({
  model: { api: "openai-completions", id: "test-model" },
  error: undefined,
});

vi.mock("../../../runtime/pi-embedded-runner/model.js", () => ({
  resolveModel: (...args: unknown[]) => mockResolveModel(...args),
}));

describe("SimpleResponderAgent", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
    setGlobalAgentRegistry(registry);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should create agent with correct config", () => {
    const agent = new SimpleResponderAgent();

    expect(agent.config.id).toBe("simple-responder");
    expect(agent.config.name).toBe("Simple Responder");
    expect(agent.config.model.tier).toBe("small");
    expect(agent.config.access.canDelegate).toBe(false);
    expect(agent.config.access.tools).toEqual([]);
  });

  it("should validate input correctly", async () => {
    const agent = new SimpleResponderAgent();

    // Valid input
    await expect(
      (agent as any).validateInput({
        userIdentifier: "user123",
        message: "hello",
      }),
    ).resolves.toBeUndefined();

    // Missing userIdentifier
    await expect(
      (agent as any).validateInput({
        message: "hello",
      }),
    ).rejects.toThrow("userIdentifier is required");

    // Missing message
    await expect(
      (agent as any).validateInput({
        userIdentifier: "user123",
      }),
    ).rejects.toThrow("message is required");
  });

  it("should build system prompt with timezone", () => {
    const agent = new SimpleResponderAgent();

    const prompt = (agent as any).buildSystemPrompt({
      userIdentifier: "user123",
      message: "hello",
      context: {
        userTimezone: "America/New_York",
      },
    });

    expect(prompt).toContain("America/New_York");
    expect(prompt).toContain("helpful assistant");
  });

  it("should build system prompt with default timezone", () => {
    const agent = new SimpleResponderAgent();

    const prompt = (agent as any).buildSystemPrompt({
      userIdentifier: "user123",
      message: "hello",
      context: {},
    });

    expect(prompt).toContain("UTC");
  });

  it("should execute and return response", async () => {
    mockCompleteSimple.mockResolvedValueOnce({
      content: [{ type: "text" as const, text: "Hello! How can I help you today?" }],
      usage: { input: 50, output: 10 },
    });

    const agent = new SimpleResponderAgent();
    const mockModel = { api: "openai-completions", id: "test-model" } as Parameters<
      typeof import("@mariozechner/pi-ai").completeSimple
    >[0];
    const input = {
      userIdentifier: "user123",
      message: "hi",
      context: {
        userTimezone: "America/Los_Angeles",
        model: { provider: "ollama", modelId: "qwen2.5:14b", resolved: mockModel },
      },
    };

    const context = {
      executionId: "test-123",
      startedAt: Date.now(),
    };

    const output = await agent.execute(input, context);

    expect(output.response).toBe("Hello! How can I help you today?");
    expect(output.tokenUsage).toBeDefined();
    expect(output.tokenUsage?.input).toBeGreaterThanOrEqual(0);
    expect(output.tokenUsage?.output).toBeGreaterThanOrEqual(0);
    expect(output.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should record trace when using executeAgent", async () => {
    mockCompleteSimple.mockResolvedValueOnce({
      content: [{ type: "text" as const, text: "Hello!" }],
      usage: { input: 20, output: 5 },
    });

    const agent = new SimpleResponderAgent();
    registry.register(agent);

    const mockModel = { api: "openai-completions", id: "test-model" } as Parameters<
      typeof import("@mariozechner/pi-ai").completeSimple
    >[0];
    const input = {
      userIdentifier: "user123",
      message: "hi",
      context: {
        model: { provider: "ollama", modelId: "qwen2.5:14b", resolved: mockModel },
      },
    };

    await executeAgent(agent, input, { recordTrace: true });

    const traces = registry.getTraces("simple-responder");
    expect(traces.length).toBeGreaterThan(0);

    const trace = traces[0];
    expect(trace?.agentId).toBe("simple-responder");
    expect(trace?.input).toEqual(input);
    expect(trace?.modelTier).toBe("small");
  });

  it("should get agent stats", async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [{ type: "text" as const, text: "Response" }],
      usage: { input: 30, output: 8 },
    });

    const agent = new SimpleResponderAgent();
    registry.register(agent);

    const mockModel = { api: "openai-completions", id: "test-model" } as Parameters<
      typeof import("@mariozechner/pi-ai").completeSimple
    >[0];
    const baseInput = {
      context: {
        model: { provider: "ollama", modelId: "qwen2.5:14b", resolved: mockModel },
      },
    };

    for (let i = 0; i < 3; i++) {
      await executeAgent(agent, {
        ...baseInput,
        userIdentifier: `user${i}`,
        message: `msg${i}`,
      });
    }

    const stats = registry.getStats("simple-responder");
    expect(stats.totalExecutions).toBe(3);
    expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.errorRate).toBe(0);
  });
});
