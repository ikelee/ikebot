import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../infra/config/config.js";
import { connectGatewayClient, getFreeGatewayPort } from "../../../server/test-helpers.e2e.js";
import { installOpenAiResponsesMock } from "../../../server/test-helpers.openai-mock.js";
import { startGatewayServer } from "../../../server/test-helpers.server.js";

// Test config for classifier - uses ollama/qwen2.5:14b
const mockConfig: OpenClawConfig = {
  agents: {
    defaults: {
      routing: {
        enabled: true,
        classifierModel: "ollama/qwen2.5:14b",
        useModelClassifier: true,
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
            id: "qwen2.5:14b",
            name: "qwen2.5:14b",
            api: "openai-completions",
            contextWindow: 32768,
            cost: { input: 0, output: 0 },
          },
        ],
      },
    },
  },
};

describe("request router e2e", () => {
  // Helper to set up model for classification tests
  async function setupClassifierModel(config: OpenClawConfig) {
    const { resolveModel } = await import("../../../runtime/pi-embedded-runner/model.js");
    const { resolveOpenClawAgentDir } = await import("../../../runtime/agent-paths.js");
    const { parseModelRef } = await import("../../../models/model-selection.js");

    const agentDir = resolveOpenClawAgentDir();
    const modelRef = parseModelRef(
      config.agents?.defaults?.routing?.classifierModel ?? "",
      "ollama",
    );

    if (!modelRef) {
      throw new Error("Failed to parse classifier model ref");
    }

    const resolved = resolveModel(modelRef.provider, modelRef.model, agentDir, config);
    if (!resolved.model) {
      throw new Error(resolved.error ?? "Model not found");
    }

    return resolved.model;
  }

  it.skip(
    "routes simple messages to simple tier with small prompt",
    { timeout: 90_000 },
    async () => {
      // TODO: full gateway integration test - skipped for now
      // The heuristic tests below validate the routing logic
    },
  );

  it("model classifier detects simple conversational inputs", { timeout: 60_000 }, async () => {
    const { phase1Classify } = await import("./phases/routing/phase-1.js");
    const model = await setupClassifierModel(mockConfig);

    const simpleConversational = [
      "hi",
      "hello",
      "hey there",
      "good morning",
      "how are you",
      "how's your day been",
      "what's up",
      "how's it going",
    ];

    for (const input of simpleConversational) {
      const result = await phase1Classify({ body: input, config: mockConfig, model });
      expect(result.decision).toBe("stay");
    }
  });

  it(
    "model classifier detects permission and capability queries as simple",
    { timeout: 60_000 },
    async () => {
      const { phase1Classify } = await import("./phases/routing/phase-1.js");
      const model = await setupClassifierModel(mockConfig);

      const permissionQueries = [
        "what can you do",
        "what do i have permission to do",
        "what are your capabilities",
        "what skills do you have",
        "list your features",
        "what commands are available",
        "show me what you can do",
      ];

      for (const query of permissionQueries) {
        const result = await phase1Classify({ body: query, config: mockConfig, model });
        expect(result.decision).toBe("stay");
      }
    },
  );

  it(
    "model classifier detects job execution requests as escalate",
    { timeout: 60_000 },
    async () => {
      const { phase1Classify } = await import("./phases/routing/phase-1.js");
      const model = await setupClassifierModel(mockConfig);

      const jobRequests = [
        "run this bash script for me",
        "execute echo hello",
        "run x and y job",
        "start the backup job",
        "execute the data processing pipeline",
        "run the migration script",
      ];

      for (const request of jobRequests) {
        const result = await phase1Classify({ body: request, config: mockConfig, model });
        expect(result.decision).toBe("escalate");
      }
    },
  );

  it(
    "model classifier detects calendar and data queries as escalate",
    { timeout: 60_000 },
    async () => {
      const { phase1Classify } = await import("./phases/routing/phase-1.js");
      const model = await setupClassifierModel(mockConfig);

      const dataQueries = [
        "do i have this on my calendar",
        "what's on my schedule today",
        "check my email for updates",
        "search my files for project notes",
        "find messages from last week",
        "read my latest emails",
      ];

      for (const query of dataQueries) {
        const result = await phase1Classify({ body: query, config: mockConfig, model });
        expect(result.decision).toBe("escalate");
      }
    },
  );

  it(
    "model classifier detects code and tool requests as escalate",
    { timeout: 60_000 },
    async () => {
      const { phase1Classify } = await import("./phases/routing/phase-1.js");
      const model = await setupClassifierModel(mockConfig);

      const codeRequests = [
        "write code to parse JSON",
        "set up a cron job",
        "install dependencies",
        "plan a multi-step workflow",
        "create a new file with this content",
        "edit the config file",
      ];

      for (const request of codeRequests) {
        const result = await phase1Classify({ body: request, config: mockConfig, model });
        expect(result.decision).toBe("escalate");
      }
    },
  );

  it("model classifier detects basic commands as simple", { timeout: 60_000 }, async () => {
    const { phase1Classify } = await import("./phases/routing/phase-1.js");

    const commands = ["/status", "/help", "/new", "/reset", "/verbose"];

    for (const cmd of commands) {
      const result = await phase1Classify({ body: cmd, config: mockConfig });
      expect(result.decision).toBe("stay");
    }
  });
});
