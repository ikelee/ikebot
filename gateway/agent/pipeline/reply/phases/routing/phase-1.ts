/**
 * Phase 1 classifier: input is normalized message body; output is stay or escalate.
 * Heuristic today; later we can call an LLM with getSystemPromptForStage("classify") only.
 * See docs/reference/tiered-model-routing.md and gateway/agent/system-prompts-by-stage.ts.
 */

export type Phase1Input = { body: string };

export type Phase1Result = { decision: "stay" | "escalate" };

const ESCALATE_PATTERNS = [
  /\b(?:run|execute|exec|script|bash|shell|command line)\b/i,
  /\b(?:plan|schedule|remind|set up|configure|install|orchestrat)\b/i,
  /\b(?:subagent|sub-agent|specialized agent|skill|multi-step)\b/i,
  /\b(?:write (?:a )?code|implement|build (?:a )?(?:small )?app)\b/i,
  /\/exec\b/i,
];

const STAY_COMMANDS = ["/status", "/help", "/new", "/reset", "/verbose", "/usage"];

function isBasicCommand(body: string): boolean {
  const t = body.trim().toLowerCase();
  for (const cmd of STAY_COMMANDS) {
    if (t === cmd || t.startsWith(`${cmd} `)) {
      return true;
    }
  }
  return false;
}

function hasEscalatePattern(body: string): boolean {
  for (const re of ESCALATE_PATTERNS) {
    if (re.test(body)) {
      return true;
    }
  }
  return false;
}

/** Classify the request: stay (Phase 1 handles it) or escalate (hand off to Phase 2). */
export function phase1Classify(input: Phase1Input): Phase1Result {
  const body = (input.body ?? "").trim();
  if (!body) {
    return { decision: "escalate" };
  }
  if (isBasicCommand(body)) {
    return { decision: "stay" };
  }
  if (hasEscalatePattern(body)) {
    return { decision: "escalate" };
  }
  // Short, likely greeting or simple question
  if (body.length <= 120 && !body.includes("?")) {
    return { decision: "stay" };
  }
  if (body.includes("?")) {
    const simplePermission = /\b(what can (you|i)|what (am i|do you) (allowed|have)|what data)\b/i;
    if (simplePermission.test(body) && body.length <= 200) {
      return { decision: "stay" };
    }
  }
  // Default: escalate when unclear
  return { decision: "escalate" };
}
