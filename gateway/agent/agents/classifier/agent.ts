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
import type { OpenClawConfig } from "../../../infra/config/config.js";
import { logModelIo } from "../../../logging/model-io.js";
import { resolveOpenClawAgentDir } from "../../../runtime/agent-paths.js";
import { log } from "../../../runtime/pi-embedded-runner/logger.js";
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../../core/agent.js";
import { extractCompletionText, resolveCompleteSimpleApiKey } from "../llm-auth.js";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompt.js";

const BASIC_COMMANDS = ["/status", "/help", "/new", "/reset", "/verbose", "/usage"];
const WEEKDAY_WORD_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|weekday)\b/i;
const DATETIME_WORD_RE = /\b(today|tomorrow|tonight|next week|next month|am|pm|\d{1,2}:\d{2})\b/i;
const CALENDAR_QUERY_RE =
  /\b(what(?:'s| is)?|show|check|list|see|do i have|am i free|free time|availability)\b/i;
const EVENT_NOUN_RE =
  /\b(concert|lesson|class|call|interview|party|dinner|lunch|breakfast|flight|trip|wedding|birthday)\b/i;

function inferDecisionFromInput(
  userInput: string,
): "stay" | "escalate" | "calendar" | "reminders" | "mail" | "workouts" | "finance" {
  const text = userInput.trim().toLowerCase();
  if (!text) {
    return "escalate";
  }

  const hasCalendarTerm =
    /\b(calendar|meeting|event|appointment|schedule|reschedule|book)\b/i.test(text) ||
    WEEKDAY_WORD_RE.test(text) ||
    DATETIME_WORD_RE.test(text);
  const hasCalendarAction = /\b(add|create|set|move|cancel|delete|plan)\b/i.test(text);
  const isCalendarQuery = CALENDAR_QUERY_RE.test(text);
  const hasImplicitTimedEvent = EVENT_NOUN_RE.test(text) && DATETIME_WORD_RE.test(text);
  if (hasImplicitTimedEvent || (hasCalendarTerm && (hasCalendarAction || isCalendarQuery))) {
    return "calendar";
  }
  if (/\bcalendar\b/i.test(text)) {
    return "calendar";
  }

  if (/\b(remind|reminder|snooze)\b/i.test(text)) {
    return "reminders";
  }
  if (/\b(mail|email|inbox|gmail|message me)\b/i.test(text)) {
    return "mail";
  }
  if (/\b(workout|gym|training|lift|exercise|run|cardio)\b/i.test(text)) {
    return "workouts";
  }
  if (/\b(spend|budget|expense|bank|credit|debit|transaction|finance)\b/i.test(text)) {
    return "finance";
  }

  return "escalate";
}

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

  async execute(input: AgentInput, context: AgentExecutionContext): Promise<AgentOutput> {
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

    const cfg = context.config as OpenClawConfig | undefined;
    const result = await this.invokeClassifierModel(model, body, cfg);
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
    cfg?: OpenClawConfig,
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

    const apiKey = await resolveCompleteSimpleApiKey({
      model,
      cfg,
      agentDir: resolveOpenClawAgentDir(),
    });

    const response = await completeSimple(
      model,
      { systemPrompt, messages },
      {
        apiKey,
        maxTokens: 128,
        temperature: 0,
      },
    );

    const accumulatedText = extractCompletionText(response);

    logModelIo(log.info.bind(log), "Router output", accumulatedText, true);
    if (!accumulatedText.trim()) {
      const fallbackDecision = inferDecisionFromInput(userInput);
      console.log(
        `[Router] empty model output; deterministic fallback decision=${fallbackDecision}`,
      );
      return { decision: fallbackDecision };
    }

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
