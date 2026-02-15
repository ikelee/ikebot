/**
 * Phase 1 classifier: input is normalized message body; output is stay or escalate.
 * Uses MODEL-BASED classification to decide routing tier.
 * NO HEURISTIC FALLBACKS - all decisions must go through a model.
 * See docs/reference/tiered-model-routing.md and gateway/agent/system-prompts-by-stage.ts.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../../../infra/config/config.js";

export type Phase1Input = {
  body: string;
  config: OpenClawConfig;
  model?: Model<Api>;
};

export type Phase1Result = { decision: "stay" | "escalate" };

const PHASE_1_CLASSIFIER_SYSTEM_PROMPT = `You are a routing classifier for an AI assistant. Your job is to classify incoming user requests into two categories:

**STAY** (handle with simple/fast path):
- Simple greetings: "hi", "hello", "how are you", "what's up"
- Permission queries: "what can you do", "what skills do you have", "what commands are available"
- Basic commands: /status, /help, /new, /reset
- Short conversational messages that don't require tools or data access

**ESCALATE** (requires complex/full-featured path):
- Job execution: "run this script", "execute X job", "start the backup"
- Data queries: "check my calendar", "search my email", "find files"
- File operations: "create file", "edit config", "write code"
- Tool usage: "install dependencies", "set up a cron job"
- Multi-step workflows or complex requests

Respond with ONLY a JSON object in this format:
{"decision": "stay"} or {"decision": "escalate"}

No explanation, no other text.`;

/**
 * Classify using a model.
 * Basic commands like /status, /help are handled without a model.
 * Everything else MUST go through the model - NO heuristic fallbacks.
 */
export async function phase1Classify(input: Phase1Input): Promise<Phase1Result> {
  const body = (input.body ?? "").trim();

  // Basic fast-path checks for explicit commands only (no language processing needed)
  if (!body) {
    return { decision: "escalate" };
  }

  const basicCommands = ["/status", "/help", "/new", "/reset", "/verbose", "/usage"];
  const lowerBody = body.toLowerCase();
  for (const cmd of basicCommands) {
    if (lowerBody === cmd || lowerBody.startsWith(`${cmd} `)) {
      return { decision: "stay" };
    }
  }

  // Everything else MUST go through the model
  if (!input.model) {
    throw new Error(
      "[phase1] Model is required for classification. No heuristic fallbacks allowed.",
    );
  }

  return await invokeClassifierModel(input.model, body);
}

async function invokeClassifierModel<T extends Api>(
  model: Model<T>,
  userInput: string,
): Promise<Phase1Result> {
  const classifierCallStart = Date.now();
  const messages = [
    {
      role: "user" as const,
      content: `Classify this request: "${userInput}"`,
      timestamp: Date.now(),
    },
  ];

  console.log(`[phase1] calling classifier model for: "${userInput.slice(0, 50)}..."`);
  const response = await completeSimple(
    model,
    {
      systemPrompt: PHASE_1_CLASSIFIER_SYSTEM_PROMPT,
      messages,
    },
    {
      apiKey: "no-api-key-needed", // Ollama doesn't require auth
      maxTokens: 128, // Classification needs very short response
      temperature: 0.3, // Lower temperature for deterministic classification
    },
  );
  console.log(`[phase1] classifier model call took ${Date.now() - classifierCallStart}ms`);

  // Extract text from response content
  let accumulatedText = "";
  if (Array.isArray(response.content)) {
    for (const item of response.content) {
      if (item.type === "text") {
        accumulatedText += item.text;
      }
    }
  }

  // Parse JSON response
  try {
    const trimmed = accumulatedText.trim();
    const parsed = JSON.parse(trimmed);
    if (parsed.decision === "stay" || parsed.decision === "escalate") {
      return { decision: parsed.decision };
    }
  } catch {
    // JSON parse failed - try to extract from text
  }

  // If we can't parse, check for keywords in response
  const lower = accumulatedText.toLowerCase();
  if (lower.includes('"stay"') || (lower.includes("stay") && !lower.includes("escalate"))) {
    return { decision: "stay" };
  }
  if (lower.includes('"escalate"') || lower.includes("escalate")) {
    return { decision: "escalate" };
  }

  // Default: escalate when unclear (safer to use full agent)
  console.warn(
    `[phase1] Could not parse model response, defaulting to escalate: ${accumulatedText.slice(0, 100)}`,
  );
  return { decision: "escalate" };
}
