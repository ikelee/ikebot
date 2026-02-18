/**
 * Classifier E2E: real model classification. Verifies the model routes correctly.
 *
 * Requires Ollama with qwen2.5:14b. Run: `ollama pull qwen2.5:14b`
 *
 * Run via: `pnpm test:e2e gateway/agent/agents/classifier/agent.e2e.test.ts`
 */

import { beforeAll, describe, expect, it } from "vitest";
import { parseModelRef } from "../../../models/model-selection.js";
import { resolveOpenClawAgentDir } from "../../../runtime/agent-paths.js";
import { resolveModel } from "../../../runtime/pi-embedded-runner/model.js";
import { executeAgent } from "../../core/agent-executor.js";
import { RouterAgent } from "./agent.js";

const OLLAMA_BASE = "http://localhost:11434";
const MODEL = "qwen2.5:14b";

const cfg = {
  models: {
    providers: {
      ollama: {
        baseUrl: `${OLLAMA_BASE}/v1`,
        api: "openai-completions" as const,
        models: [
          {
            id: MODEL,
            name: "Qwen",
            api: "openai-completions" as const,
            contextWindow: 128000,
            cost: { input: 0, output: 0 },
          },
        ],
      },
    },
  },
};

async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function modelAvailable(): Promise<boolean> {
  try {
    const tags = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    }).then((r) => r.json());
    const models = (tags?.models ?? []) as Array<{ name?: string; model?: string }>;
    return models.some(
      (m) => (m.name ?? "").startsWith(MODEL) || (m.model ?? "").startsWith(MODEL),
    );
  } catch {
    return false;
  }
}

function createModelResolver() {
  const modelRef = parseModelRef(`ollama/${MODEL}`, "ollama");
  if (!modelRef) {
    return () => Promise.resolve(undefined);
  }
  const agentDir = resolveOpenClawAgentDir();
  return async () => {
    const resolved = resolveModel(modelRef.provider, modelRef.model, agentDir, cfg as any);
    return resolved.model;
  };
}

/** Hardcoded cases – no model call; run even when Ollama unavailable. */
const HARDCODED_CASES: Array<{ message: string; expected: string }> = [
  { message: "/status", expected: "stay" },
  { message: "/help", expected: "stay" },
  { message: "/reset", expected: "escalate" },
  { message: "/new", expected: "escalate" },
];

/** Model-invoking cases from agent.test.ts – real model must classify correctly. */
const MODEL_CASES: Array<{
  message: string;
  expected: string | string[];
  expectedAgents?: string[];
}> = [
  { message: "hello", expected: "stay" },
  { message: "what agents do I have available to me?", expected: ["stay", "escalate"] },
  { message: "run this bash script", expected: "escalate" },
  { message: "what's on my calendar today", expected: "calendar" },
  { message: "schedule a meeting tomorrow", expected: "calendar" },
  { message: "can you summarize my recent workouts?", expected: "workouts" },
  {
    message: "what do I need to hit tomorrow at the gym?",
    expected: "multi",
    expectedAgents: ["calendar", "workouts"],
  },
  { message: "asdfgh", expected: "escalate" },
];

function runClassifyTest(message: string, expected: string | string[], expectedAgents?: string[]) {
  const modelResolver = createModelResolver();
  const agent = new RouterAgent(modelResolver);
  return executeAgent(agent, { userIdentifier: "user", message }, { recordTrace: false }).then(
    (output) => {
      const expectedDecisions = Array.isArray(expected) ? expected : [expected];
      expect(expectedDecisions).toContain(output.decision);
      if (expectedDecisions.includes("multi") && expectedAgents) {
        expect(output.agents).toBeDefined();
        expect(output.agents?.toSorted()).toEqual([...expectedAgents].toSorted());
      }
    },
  );
}

describe("RouterAgent e2e – real model classification", () => {
  let canRun: boolean;

  beforeAll(async () => {
    const ollamaOk = await ollamaAvailable();
    const modelOk = ollamaOk && (await modelAvailable());
    canRun = modelOk;
    if (!ollamaOk) {
      console.warn(
        "[classifier e2e] Ollama not available at localhost:11434 – skipping model tests. Run `ollama serve`.",
      );
    } else if (!modelOk) {
      console.warn(
        `[classifier e2e] Model ${MODEL} not found – skipping model tests. Run \`ollama pull ${MODEL}\`.`,
      );
    }
  });

  describe("hardcoded routing (no model)", () => {
    for (const { message, expected } of HARDCODED_CASES) {
      it(`classifies "${message}" as ${expected}`, async () => {
        await runClassifyTest(message, expected);
      });
    }
  });

  describe("model classification", () => {
    for (const { message, expected, expectedAgents } of MODEL_CASES) {
      it(
        `classifies "${message.slice(0, 45)}${message.length > 45 ? "…" : ""}" as ${expected}`,
        {
          timeout: 120_000,
        },
        async () => {
          if (!canRun) {
            return;
          }
          await runClassifyTest(message, expected, expectedAgents);
        },
      );
    }
  });
});
