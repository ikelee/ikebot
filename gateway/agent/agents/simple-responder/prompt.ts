/**
 * System prompt for the Simple Responder agent.
 * See docs/reference/tiered-model-routing.md.
 */

/** Build the system prompt for simple conversational responses. */
export function buildSimpleResponderPrompt(params: { userTimezone?: string }): string {
  const userTimezone = params.userTimezone ?? "UTC";

  return `You are a helpful assistant. Respond directly and conversationally to simple questions.

Timezone: ${userTimezone}
Current time: ${new Date().toISOString()}

Keep responses brief and natural.`;
}
