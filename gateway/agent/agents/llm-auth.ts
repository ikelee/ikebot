import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../infra/config/config.js";
import { getApiKeyForModel, requireApiKey } from "../../models/model-auth.js";
import { normalizeProviderId } from "../../models/model-selection.js";

const NO_API_KEY_PROVIDERS = new Set(["local", "ollama", "lmstudio"]);

export async function resolveCompleteSimpleApiKey(params: {
  model: Model<Api>;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<string> {
  const normalizedProvider = normalizeProviderId(params.model.provider);
  if (NO_API_KEY_PROVIDERS.has(normalizedProvider)) {
    return "no-api-key-needed";
  }

  const auth = await getApiKeyForModel({
    model: params.model,
    cfg: params.cfg,
    agentDir: params.agentDir,
  });
  if (auth.mode === "aws-sdk") {
    return "no-api-key-needed";
  }
  return requireApiKey(auth, params.model.provider);
}

export function extractCompletionText(response: unknown): string {
  const responseRecord = response as Record<string, unknown>;
  let text = "";

  const content = responseRecord.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const block = item as Record<string, unknown>;
      const type = block.type;
      const blockText = block.text;
      if ((type === "text" || type === "output_text") && typeof blockText === "string") {
        text += blockText;
      }
    }
  }

  if (!text && typeof responseRecord.output_text === "string") {
    text = responseRecord.output_text;
  }

  const output = responseRecord.output;
  if (!text && Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const outputItem = item as Record<string, unknown>;
      if (outputItem.type !== "message" || !Array.isArray(outputItem.content)) {
        continue;
      }
      for (const block of outputItem.content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const blockRecord = block as Record<string, unknown>;
        const type = blockRecord.type;
        const blockText = blockRecord.text;
        if ((type === "text" || type === "output_text") && typeof blockText === "string") {
          text += blockText;
        }
      }
    }
  }

  return text;
}
