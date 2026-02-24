/**
 * Simple Responder Agent (Agent 3a)
 *
 * Model Tier: Small (3B-7B local)
 * Cost: <$0.0001/request
 * Purpose: Generate conversational responses to simple inquiries
 * Access: User timezone, basic preferences only - no tools
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../infra/config/config.js";
import { logModelIo } from "../../../logging/model-io.js";
import { resolveOpenClawAgentDir } from "../../../runtime/agent-paths.js";
import { log } from "../../../runtime/pi-embedded-runner/logger.js";
import { resolveModel } from "../../../runtime/pi-embedded-runner/model.js";
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../../core/agent.js";
import {
  buildCompleteSimpleOptions,
  extractCompletionText,
  resolveCompleteSimpleApiKey,
} from "../llm-auth.js";
import { buildSimpleResponderPrompt } from "./prompt.js";

export class SimpleResponderAgent extends Agent {
  constructor() {
    const config: AgentConfig = {
      id: "simple-responder",
      name: "Simple Responder",
      purpose:
        "Generate conversational responses to simple inquiries without tools or deep context",
      access: {
        data: ["user_timezone", "user_preferences"],
        documents: [],
        scripts: [],
        features: ["direct_llm_completion"],
        skills: [],
        tools: [],
        canDelegate: false,
      },
      model: {
        tier: "small",
        provider: "ollama",
        modelId: "qwen2.5:3b",
        maxTokens: 2048,
        temperature: 0.7,
      },
    };
    super(config);
  }

  async execute(input: AgentInput, context: AgentExecutionContext): Promise<AgentOutput> {
    await this.validateInput(input);

    const startTime = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const systemPrompt = buildSimpleResponderPrompt({
        userTimezone: (input.context?.userTimezone as string) || "UTC",
      });

      console.log("[SimpleResponder] model call 2");
      logModelIo(log.info.bind(log), "SimpleResponder input system", systemPrompt, true);
      logModelIo(log.info.bind(log), "SimpleResponder input user", input.message ?? "", true);

      const messages: Array<{ role: "user"; content: string; timestamp: number }> = [
        {
          role: "user",
          content: input.message,
          timestamp: Date.now(),
        },
      ];

      const modelOverride = input.context?.model as
        | { provider: string; modelId: string; resolved?: Model<Api> }
        | undefined;
      const cfg = input.context?.config as OpenClawConfig | undefined;

      let model: Model<Api>;
      if (modelOverride?.resolved) {
        model = modelOverride.resolved;
      } else if (modelOverride) {
        const agentDir = resolveOpenClawAgentDir();
        const resolved = resolveModel(modelOverride.provider, modelOverride.modelId, agentDir, cfg);
        if (!resolved.model) {
          throw new Error(
            resolved.error ?? `Model not found: ${modelOverride.provider}/${modelOverride.modelId}`,
          );
        }
        model = resolved.model;
      } else {
        const modelConfig = this.getModelConfig();
        const agentDir = resolveOpenClawAgentDir();
        const resolved = resolveModel(modelConfig.provider, modelConfig.modelId, agentDir, cfg);
        if (!resolved.model) {
          throw new Error(
            resolved.error ?? `Model not found: ${modelConfig.provider}/${modelConfig.modelId}`,
          );
        }
        model = resolved.model;
      }

      const modelConfig = this.getModelConfig();
      const apiKey = await resolveCompleteSimpleApiKey({
        model,
        cfg,
        agentDir: resolveOpenClawAgentDir(),
      });

      const response = await completeSimple(
        model,
        { systemPrompt, messages },
        buildCompleteSimpleOptions({
          model,
          apiKey,
          maxTokens: modelConfig.maxTokens,
          temperature: modelConfig.temperature,
        }),
      );

      const responseText = extractCompletionText(response);

      logModelIo(log.info.bind(log), "SimpleResponder output", responseText, true);

      inputTokens = Math.ceil((systemPrompt.length + input.message.length) / 4);
      outputTokens = Math.ceil(responseText.length / 4);

      return {
        response: responseText.trim(),
        tokenUsage: {
          input: inputTokens,
          output: outputTokens,
        },
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      throw new Error(
        `SimpleResponderAgent execution failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}
