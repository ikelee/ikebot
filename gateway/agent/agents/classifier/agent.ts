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
import { logModelIo } from "../../../logging/model-io.js";
import { log } from "../../../runtime/pi-embedded-runner/logger.js";
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../../core/agent.js";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompt.js";

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
        provider: "ollama",
        modelId: "qwen2.5:3b",
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
  }

  async execute(input: AgentInput, _context: AgentExecutionContext): Promise<AgentOutput> {
    await this.validateInput(input);

    const startTime = Date.now();
    const body = (input.message ?? "").trim();

    if (!body) {
      return {
        decision: "escalate",
        metadata: { reason: "empty_body" },
        durationMs: Date.now() - startTime,
      };
    }

    const lowerBody = body.toLowerCase();
    if (lowerBody === "/reset" || lowerBody === "/new") {
      return {
        decision: "escalate",
        metadata: { reason: "bare_reset_greeting" },
        durationMs: Date.now() - startTime,
      };
    }

    for (const cmd of BASIC_COMMANDS) {
      if (lowerBody === cmd || lowerBody.startsWith(`${cmd} `)) {
        return {
          decision: "stay",
          metadata: { reason: "basic_command", command: cmd },
          durationMs: Date.now() - startTime,
        };
      }
    }

    const model = await this.modelResolver();
    if (!model) {
      return {
        decision: "escalate",
        metadata: { reason: "no_classifier_model" },
        durationMs: Date.now() - startTime,
      };
    }

    const result = await this.invokeClassifierModel(model, body);
    return {
      decision: result.decision,
      agents: result.agents,
      metadata: { modelUsed: true },
      tokenUsage: result.tokenUsage,
      durationMs: Date.now() - startTime,
    };
  }

  private async invokeClassifierModel(
    model: Model<Api>,
    userInput: string,
  ): Promise<{
    decision:
      | "stay"
      | "escalate"
      | "calendar"
      | "reminders"
      | "mail"
      | "workouts"
      | "finance"
      | "multi";
    agents?: string[];
    tokenUsage?: { input: number; output: number };
  }> {
    const systemPrompt = CLASSIFIER_SYSTEM_PROMPT;
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
        temperature: 0,
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

    const validDecisions = [
      "stay",
      "escalate",
      "calendar",
      "reminders",
      "mail",
      "workouts",
      "finance",
      "multi",
    ] as const;
    try {
      const trimmed = accumulatedText.trim();
      const parsed = JSON.parse(trimmed);
      if (validDecisions.includes(parsed.decision)) {
        const agents = Array.isArray(parsed.agents)
          ? (parsed.agents as string[]).filter(
              (a): a is string => typeof a === "string" && a.trim().length > 0,
            )
          : undefined;
        return {
          decision: parsed.decision,
          agents: agents?.length ? agents.map((a) => a.trim().toLowerCase()) : undefined,
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
    for (const d of ["multi", "calendar", "reminders", "mail", "workouts", "finance"] as const) {
      if (lower.includes(`"${d}"`) || lower.includes(d)) {
        return { decision: d };
      }
    }
    if (lower.includes('"escalate"') || lower.includes("escalate")) {
      return { decision: "escalate" };
    }

    return { decision: "escalate" };
  }
}
