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
        provider: "local",
        modelId: "llama-3.2-3b",
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
      const cfg = input.context?.config as Parameters<typeof resolveModel>[3];

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

      const response = await completeSimple(
        model,
        { systemPrompt, messages },
        {
          apiKey: "no-api-key-needed",
          maxTokens: modelConfig.maxTokens,
          temperature: modelConfig.temperature,
        },
      );

      let responseText = "";
      if (Array.isArray(response.content)) {
        for (const item of response.content) {
          if (item.type === "text") {
            responseText += item.text;
          }
        }
      }

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
