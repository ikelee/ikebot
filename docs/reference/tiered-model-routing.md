---
summary: "Multi-step model routing: Phase 1 gate (classify), Phase 2 plan, Phase 3 execute"
read_when:
  - Designing or implementing tiered model routing
  - Routing requests by complexity to save tokens and cost
  - Choosing which model handles classification vs planning vs execution
title: "Tiered Model Routing (Design)"
---

# Tiered model routing

Each phase has a designated **input**, **purpose**, and **system prompt** that reflects only that purpose. No single massive system prompt—the prompt at each stage is scoped to what we want to achieve there.

## Flow

**Every request goes through Phase 1 first.** Phase 1 decides: can we handle this here (stay) or hand off (escalate to Phase 2)? Phase 1 has the least clearance: it can do a few limited things quickly and cheaply. If the request is too complex, unclear, or wants something Phase 1 is not allowed to do, we escalate. Phase 2 and Phase 3 are outlined below; this doc focuses on Phase 1 and clean code structure.

---

## Phase 1: Gate (classify → stay or escalate)

Phase 1 is the single entry point. It has **least clearance**: no script execution, no specialized agents; it can do limited things only.

### Input

- Normalized user message body (after directives and inline actions).
- Optional: session key (for future context). No full conversation history; keep input minimal.

### Purpose

**Sole purpose:** Check if this is:

1. **Simple conversation** — Greetings, chitchat, simple Q&A answerable in one turn without tools or heavy context.
2. **Permission lookup** — "What can I do?", "What am I allowed to do?", "What do you have on me?", "What data do you have stored?" (read-only, single scope).
3. **Running a (basic) command** — Single-step commands Phase 1 is allowed to run: e.g. /status, /help, /new, /reset, /verbose, /usage. No script execution, no specialized agents.

If the request clearly fits one of the above → **stay** (Phase 1 handles it).  
If too complex, unclear, or asks for something Phase 1 cannot do → **escalate** to Phase 2.

### What Phase 1 can do

- Answer simple conversation (one turn).
- Answer permission/capability / "my data" lookups from existing context.
- Run basic commands only: status, help, session reset, verbose/usage toggles (allowlist of slash commands).
- **No script execution.** No exec, no "run this script", no job kickoff.
- **No specialized agents.** No subagents, no skills, no multi-step tool orchestration.
- **No plan/outline/scheduling.** No "give me a plan", "schedule X", "remind me", "set up", "configure", "install" as multi-step flows.

Phase 1 is fast and cheap: small local model, minimal prompt. If we can't clearly understand the request or it's beyond the list above → **escalate**.

### What Phase 1 cannot do

- Start or trigger script execution.
- Invoke specialized agents or subagents.
- Multi-step plans, scheduling, configuration, or orchestration.
- Anything requiring the full agent system prompt (full tools, full agents) or a bigger model.

### System prompt for Phase 1

**Minimal only.** No full agent persona, no full tool list, no workspace context. The Phase 1 prompt:

- States the role: you are the Phase 1 classifier.
- States the two outcomes: **stay** (Phase 1 handles it) or **escalate** (hand off to Phase 2).
- Defines "stay": simple conversation, permission lookup, or running a basic command from the allowlist. No script execution, no specialized agents.
- Defines "escalate": unclear intent, or request for script execution, specialized agents, plans, scheduling, or anything beyond Phase 1 clearance.
- Asks for exactly one word: **stay** or **escalate**.

Implemented in `src/agents/system-prompts-by-stage.ts` as `PHASE_1_CLASSIFIER_SYSTEM_PROMPT` / `getSystemPromptForStage("classify")`. When we add an LLM for Phase 1, **only this prompt** is sent—never the full agent prompt.

### Output

- **stay** — Phase 1 handles it (simple conversation, permission lookup, or basic command). We then proceed to generate a reply (today: main agent with full prompt; later we may scope the reply path for "stay").
- **escalate** — Hand off to Phase 2. Do not handle in Phase 1.

The heuristic in code mirrors these rules and returns the equivalent of stay or escalate.

### Code layout

- **`src/auto-reply/reply/phases/routing/phase-1.ts`** — Phase 1 only. Input: body. Output: **stay** | **escalate**. Contains classification logic (heuristic today; LLM later using `getSystemPromptForStage("classify")` only). No routing config, no model override—just the decision.
- **`src/auto-reply/reply/request-router.ts`** — Orchestrator: calls Phase 1, then applies config (e.g. override provider/model when stay and routing enabled), emits events, returns result for get-reply.
- **`src/agents/system-prompts-by-stage.ts`** — Single source of truth for Phase 1 (and later Phase 2) system prompt text.

---

## Phase 2: Plan and clarify (outline)

When Phase 1 returns **escalate**, we go to Phase 2. Details TBD.

- **Input:** User message + Phase 1 context (e.g. "escalate").
- **Purpose:** Produce a structured plan (steps, tools, agents). Do not execute; do not chat.
- **System prompt:** Dedicated planner prompt: full tools + agents + guardrails; output a plan only.
- **Output:** Structured plan for Phase 3 (orchestrator) to execute. Optionally ask the user for more time.

---

## Phase 3: Execute and finish (outline)

- **Actor:** Local orchestrator (same process as Phase 1).
- **Purpose:** Execute the plan from Phase 2: run tools, call agents, gather results. Loop back to Phase 2 if ambiguous or failed step. Produce final reply and close the loop.

---

## Existing flow and where the router interjects

1. **Entry** — `dispatchInboundMessage` → `dispatchReplyFromConfig` → `getReplyFromConfig` (ctx, opts, cfg).
2. **getReplyFromConfig** — finalizeInboundContext, initSessionState, resolveReplyDirectives, handleInlineActions, stageSandboxMedia → **request-router** (Phase 1 + override) → runPreparedReply.
3. **runPreparedReply** → runReplyAgent → runAgentTurnWithFallback → runEmbeddedPiAgent / runCliAgent (full system prompt is used here for the main agent turn).

**Router injection point:** In get-reply.ts, after we have cleanedBody and provider/model, **before** runPreparedReply. The router calls **Phase 1** (routing/phase-1.ts) to get stay or escalate; then applies config and returns provider/model for the next step. When routing is enabled and Phase 1 says stay, we override to the classifier model and proceed to runPreparedReply. When Phase 1 says escalate, we return useDefault (today we still run the main agent; later we will branch to Phase 2).

---

## Implementation status

- **Phase 1:** Implemented as heuristic in `routing/phase-1.ts`; config in `agents.defaults.routing` (enabled, classifierModel). When enabled and Phase 1 says stay, provider/model override to classifier; routing events emitted for dashboard. Phase 1 system prompt is in system-prompts-by-stage.ts; LLM call for Phase 1 not yet wired (will use that prompt only).
- **Phase 2 / Phase 3:** Not yet implemented.
