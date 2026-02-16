/**
 * Routing architecture: agents, relationships, and prompts.
 * Mirrors gateway/agent structure. Prompts kept in sync with gateway/agent/system-prompts-by-stage.ts
 * and gateway/agent/agents/simple-responder.ts.
 */

export type RoutingAgentTier = "small" | "medium" | "large";

export type RoutingAgentNode = {
  id: string;
  name: string;
  purpose: string;
  tier: RoutingAgentTier;
  modelHint: string;
  access: {
    data: string[];
    tools: string[];
    canDelegate: boolean;
  };
  /** System prompt shown on hover. */
  systemPrompt: string;
};

export type RoutingFlowEdge = {
  from: string;
  to: string;
  label: string;
};

/** Entry point for all agent invocation. */
export const ROUTING_ENTRY = {
  id: "entry",
  name: "runAgentFlow",
  file: "gateway/agent/run.ts",
  caller: "get-reply.ts",
} as const;

/** Routing agents with structured config and prompts. */
export const ROUTING_AGENTS: RoutingAgentNode[] = [
  {
    id: "router",
    name: "Router",
    purpose: "Model call 1: classify → stay or escalate",
    tier: "small",
    modelHint: "7B local · ~128 tokens",
    access: {
      data: ["user_profile_public", "recent_activity_summary"],
      tools: [],
      canDelegate: false,
    },
    systemPrompt: `You are the Phase 1 classifier. Your only job is to read the user message and reply with exactly one word: stay or escalate.

**stay** — You will handle this yourself: respond to the user or execute the basic command. The request clearly fits one of these:
- Simple conversation: greetings, chitchat, or a simple Q&A answerable in one turn without tools or heavy context.
- Permission lookup: "What can I do?", "What am I allowed to do?", "What do you have on me?", "What data do you have stored?" (read-only, single scope).
- Running a basic command: single-step commands you can run here, e.g. /status, /help, /new, /reset, /verbose, /usage. No script execution, no specialized agents.

**escalate** — Do not handle this here. Hand off to the full agent (Phase 2). The request is unclear, or it asks for any of the following:
- Script execution, exec, "run this script", job kickoff.
- Specialized agents, subagents, skills, multi-step tool orchestration.
- Plans, outlines, scheduling, "remind me", "set up", "configure", "install" as multi-step flows.
- Anything that needs the full agent (full tools, full context) or a bigger model.

Reply with exactly one word: stay or escalate.`,
  },
  {
    id: "simple-responder",
    name: "Simple Responder",
    purpose: "Model call 2: generate the reply",
    tier: "small",
    modelHint: "3B–7B local · 2048 tokens",
    access: {
      data: ["user_timezone", "user_preferences"],
      tools: [],
      canDelegate: false,
    },
    systemPrompt: `You are a helpful assistant. Respond directly and conversationally to simple questions.

Timezone: UTC (or from context)
Current time: (injected at runtime)

Keep responses brief and natural.`,
  },
  {
    id: "complex",
    name: "Full Agent",
    purpose: "Model call 2: full agent with tools, skills, multi-step reasoning",
    tier: "large",
    modelHint: "Claude/GPT-4 or large local",
    access: {
      data: ["full_context"],
      tools: ["all tools", "skills", "subagents"],
      canDelegate: true,
    },
    systemPrompt: `Full agent system prompt built from:
- Agent bootstrap (soul, identity, user)
- Tools allowlist and definitions
- Skills and subagent registry
- Memory and context

Built at runtime in attempt.ts → buildEmbeddedSystemPrompt.`,
  },
];

/** Flow edges: from → to with label. */
export const ROUTING_EDGES: RoutingFlowEdge[] = [
  { from: "entry", to: "router", label: "classify" },
  { from: "router", to: "simple-responder", label: "stay" },
  { from: "router", to: "complex", label: "escalate" },
];
