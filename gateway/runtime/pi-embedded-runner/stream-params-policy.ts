export type StreamParamName = "temperature" | "maxTokens" | "cacheRetention";

/**
 * Central policy for provider/model stream params.
 * Callers should not hardcode provider-specific filtering rules.
 */
export function isStreamParamAllowed(params: {
  provider: string;
  modelId: string;
  param: StreamParamName;
}): boolean {
  const provider = params.provider.trim().toLowerCase();
  const _modelId = params.modelId.trim().toLowerCase();

  // ChatGPT Codex responses rejects temperature for this endpoint/account mode.
  if (provider === "openai-codex" && params.param === "temperature") {
    return false;
  }

  return true;
}
