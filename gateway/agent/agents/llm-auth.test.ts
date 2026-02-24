import { describe, expect, it } from "vitest";
import { buildCompleteSimpleOptions } from "./llm-auth.js";

describe("buildCompleteSimpleOptions", () => {
  it("omits temperature for openai-codex models", () => {
    const options = buildCompleteSimpleOptions({
      model: {
        provider: "openai-codex",
        id: "gpt-5.1-codex-mini",
      } as never,
      apiKey: "test-key",
      maxTokens: 128,
      temperature: 0,
    });

    expect(options.temperature).toBeUndefined();
    expect(options.maxTokens).toBe(128);
  });

  it("keeps temperature for non-codex providers", () => {
    const options = buildCompleteSimpleOptions({
      model: {
        provider: "ollama",
        id: "qwen2.5:3b",
      } as never,
      apiKey: "test-key",
      maxTokens: 128,
      temperature: 0.3,
    });

    expect(options.temperature).toBe(0.3);
    expect(options.maxTokens).toBe(128);
  });
});
