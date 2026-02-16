---
summary: "Multi-step model routing: Phase 1 gate (classify), Phase 2 plan, Phase 3 execute"
read_when:
  - Designing or implementing tiered model routing
  - Routing requests by complexity to save tokens and cost
  - Choosing which model handles classification vs planning vs execution
title: "Tiered Model Routing"
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

Implemented in `gateway/agent/system-prompts-by-stage.ts` as `PHASE_1_CLASSIFIER_SYSTEM_PROMPT` / `getSystemPromptForStage("classify")`. When Phase 1 calls an LLM, **only this prompt** is sent—never the full agent prompt.

### Output

- **stay** — Phase 1 handles it (simple conversation, permission lookup, or basic command). Tier is set to "simple" and the runtime uses the fast path.
- **escalate** — Hand off to Phase 2 (or today: full agent). Tier is set to "complex" and the runtime uses the full agent path.

The LLM-based classifier returns the decision, which the router converts to tier.

### Code layout

- **`gateway/agent/pipeline/reply/agent-runner/phases/routing/phase-1.ts`** — Phase 1 only. Input: body. Output: **stay** | **escalate**. Contains LLM-based classification using `getSystemPromptForStage("classify")`.
- **`gateway/agent/pipeline/reply/agent-runner/routing/request-router.ts`** — Orchestrator: calls Phase 1, then applies config (e.g. override provider/model when stay and routing enabled), emits events, returns result with tier ("simple" or "complex").
- **`gateway/agent/system-prompts-by-stage.ts`** — Single source of truth for Phase 1 (and later Phase 2) system prompt text (`PHASE_1_CLASSIFIER_SYSTEM_PROMPT`).

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
2. **getReplyFromConfig** — finalizeInboundContext, initSessionState, resolveReplyDirectives, handleInlineActions, stageSandboxMedia → **routeRequest()** → runPreparedReply({ ..., replyTier }).
3. **runPreparedReply** → runReplyAgent({ ..., replyTier }) → runAgentTurnWithFallback → queueEmbeddedPiMessage({ ..., replyTier }) → runEmbeddedPiAgent → runEmbeddedAttempt({ ..., replyTier }).
4. **runEmbeddedAttempt** — Checks `replyTier`:
   - **"simple"** → `runSimpleTierFastPath` (no session, no full prompt, no tools)
   - **"complex"** → Full agent path (buildEmbeddedSystemPrompt, createAgentSession, tools, streaming)

**Router injection point (implemented):** In `gateway/agent/pipeline/reply/reply-building/get-reply.ts`, after we have cleanedBody and provider/model, **before** runPreparedReply. The router calls **Phase 1** (`phase1Classify`) to get stay or escalate, then applies config and returns provider/model and **tier** ("simple" or "complex") which flows all the way to attempt.ts.

---

## Implementation status

- **Phase 1: ✅ IMPLEMENTED**
  - **Classification:** LLM-based classification in `gateway/agent/pipeline/reply/agent-runner/phases/routing/phase-1.ts` using `PHASE_1_CLASSIFIER_SYSTEM_PROMPT` from `gateway/agent/system-prompts-by-stage.ts`.
  - **Router:** `routeRequest` in `gateway/agent/pipeline/reply/agent-runner/routing/request-router.ts` calls Phase 1, applies config, returns tier ("simple" or "complex") and optional provider/model override.
  - **Integration:** `routeRequest` is called from `gateway/agent/pipeline/reply/reply-building/get-reply.ts` and tier flows through `runPreparedReply` → `runReplyAgent` → `queueEmbeddedPiMessage` → `runEmbeddedPiAgent` → `runEmbeddedAttempt`.
  - **Execution paths:**
    - **Simple tier:** `runSimpleTierFastPath` in `gateway/runtime/pi-embedded-runner/run/attempt.ts` — no session, no full prompt, no tools, direct `completeSimple()` call.
    - **Complex tier:** Full agent path in same file — `buildEmbeddedSystemPrompt`, session creation, tools, streaming.
  - **E2E tests:** Coverage in `gateway/agent/pipeline/reply/e2e/tiered-routing.e2e.test.ts`.

- **Phase 2 / Phase 3:** Not yet implemented.

---

## Routing events and observability

Routing decisions are emitted via `emitAgentEvent({ stream: "routing", data: { decision, tier, bodyPreview, ... } })` from `gateway/agent/run.ts`. The web UI (Model routing tab) receives these events over the agent event stream and buffers up to 200 entries in memory.

**Previous inputs:** Events are **not persisted** to disk. They are buffered in the web client only; a refresh or reconnect clears the history. To inspect past routing decisions, use the Model routing tab while the gateway is running and messages are flowing.
