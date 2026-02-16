/**
 * Router Agent (Agent 2) - Phase 1 Classifier
 *
 * Model Tier: Small (7B local)
 * Cost: <$0.0001/request
 * Purpose: Classify incoming messages as simple (stay) or complex (escalate)
 * Access: Surface-level public user info only - no tools, no delegation
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import { logModelIo } from "../../logging/model-io.js";
import { log } from "../../runtime/pi-embedded-runner/logger.js";
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../core/agent.js";
import { getSystemPromptForStage } from "../system-prompts-by-stage.js";

const BASIC_COMMANDS = ["/status", "/help", "/new", "/reset", "/verbose", "/usage"];

export type RouterAgentModelResolver = () => Promise<Model<Api> | undefined>;

export class RouterAgent extends Agent {
  constructor(
    /** Resolver for the classifier model - returns undefined if routing disabled */
    private readonly modelResolver: RouterAgentModelResolver,
  ) {
    const config: AgentConfig = {
      id: "router",
      name: "Router",
      purpose:
        "Identify whether this is a simple inquiry that can be answered directly, or a complex request requiring tools, planning, or multi-step execution",
      access: {
        data: ["user_profile_public", "recent_activity_summary"],
        documents: ["classification_guidelines"],
        scripts: [],
        features: ["llm_classification"],
        skills: [],
        tools: [],
        canDelegate: false,
      },
      model: {
        tier: "small",
        provider: "local",
        modelId: "llama-3.2-7b",
        maxTokens: 128,
        temperature: 0.3,
      },
    };
    super(config);
  }

  protected async validateInput(input: AgentInput): Promise<void> {
    if (!input.userIdentifier) {
      throw new Error(`Agent ${this.config.id}: userIdentifier is required`);
    }
    // Allow empty message - Router treats it as escalate
  }

  async execute(input: AgentInput, context: AgentExecutionContext): Promise<AgentOutput> {
    await this.validateInput(input);

    const startTime = Date.now();
    const body = (input.message ?? "").trim();

    // Empty message: escalate (safer)
    if (!body) {
      return {
        decision: "escalate",
        metadata: { reason: "empty_body" },
        durationMs: Date.now() - startTime,
      };
    }

    // Bare /reset and /new escalate to complex path so greeting prompt can run
    const lowerBody = body.toLowerCase();
    if (lowerBody === "/reset" || lowerBody === "/new") {
      return {
        decision: "escalate",
        metadata: { reason: "bare_reset_greeting" },
        durationMs: Date.now() - startTime,
      };
    }

    // Fast-path: other basic commands (no LLM needed)
    for (const cmd of BASIC_COMMANDS) {
      if (lowerBody === cmd || lowerBody.startsWith(`${cmd} `)) {
        return {
          decision: "stay",
          metadata: { reason: "basic_command", command: cmd },
          durationMs: Date.now() - startTime,
        };
      }
    }

    // Everything else: LLM classification
    const model = await this.modelResolver();
    if (!model) {
      // No model configured: default to escalate (use full agent)
      return {
        decision: "escalate",
        metadata: { reason: "no_classifier_model" },
        durationMs: Date.now() - startTime,
      };
    }

    const result = await this.invokeClassifierModel(model, body);
    return {
      decision: result.decision,
      metadata: { modelUsed: true },
      tokenUsage: result.tokenUsage,
      durationMs: Date.now() - startTime,
    };
  }

  private async invokeClassifierModel(
    model: Model<Api>,
    userInput: string,
  ): Promise<{ decision: "stay" | "escalate"; tokenUsage?: { input: number; output: number } }> {
    const systemPrompt = getSystemPromptForStage("classify");
    console.log("[Router] model call 1: classifier");
    logModelIo(log.info.bind(log), "Router input system", systemPrompt, true);
    logModelIo(log.info.bind(log), "Router input user", userInput, true);

    const messages = [
      {
        role: "user" as const,
        content: `Classify this request: "${userInput}"`,
        timestamp: Date.now(),
      },
    ];

    const response = await completeSimple(
      model,
      { systemPrompt, messages },
      {
        apiKey: "no-api-key-needed",
        maxTokens: 128,
        temperature: 0.3,
      },
    );

    let accumulatedText = "";
    if (Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item.type === "text") {
          accumulatedText += item.text;
        }
      }
    }

    logModelIo(log.info.bind(log), "Router output", accumulatedText, true);

    // Parse JSON response
    try {
      const trimmed = accumulatedText.trim();
      const parsed = JSON.parse(trimmed);
      if (parsed.decision === "stay" || parsed.decision === "escalate") {
        return {
          decision: parsed.decision,
          tokenUsage: response.usage
            ? { input: response.usage.input ?? 0, output: response.usage.output ?? 0 }
            : undefined,
        };
      }
    } catch {
      // JSON parse failed - try keyword extraction
    }

    const lower = accumulatedText.toLowerCase();
    if (lower.includes('"stay"') || (lower.includes("stay") && !lower.includes("escalate"))) {
      return { decision: "stay" };
    }
    if (lower.includes('"escalate"') || lower.includes("escalate")) {
      return { decision: "escalate" };
    }

    // Default: escalate when unclear
    return { decision: "escalate" };
  }
}
