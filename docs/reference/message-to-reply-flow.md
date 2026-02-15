# Message-to-reply flow (gateway receives a message → system prompt)

This doc maps the code path from “gateway receives a message” (e.g. “hi” from TUI) to where the **system prompt** is built, and why the **small Phase 1 prompt** (easy-input classifier) is not used today.

---

## 1. End-to-end flow (e.g. TUI → “hi” → reply)

```
TUI (or other client)
  → WebSocket message (e.g. method "run" with prompt "hi")
  → gateway/server/server/ws-connection/message-handler.ts
      attachGatewayWsMessageHandler → on message → handleGatewayRequest
  → gateway/server/server-methods.ts
      handleGatewayRequest(req, respond, client, …) → handler = coreGatewayHandlers[req.method] or extraHandlers[req.method]
  → gateway/server/server-methods/chat.ts
      chatHandlers.run → builds MsgContext → dispatchInboundMessage({ ctx, cfg, dispatcher })
  → gateway/agent/pipeline/dispatch.ts
      dispatchInboundMessage → finalizeInboundContext → dispatchReplyFromConfig({ …, replyResolver: getReplyFromConfig })
  → gateway/agent/pipeline/reply/dispatch-from-config.ts
      dispatchReplyFromConfig → eventually calls (replyResolver ?? getReplyFromConfig)(ctx, opts, cfg)
  → gateway/agent/pipeline/reply/get-reply.ts
      getReplyFromConfig → resolveReplyDirectives → … → runPreparedReply({ provider, model, … })
  → gateway/agent/pipeline/reply/get-reply-run.ts
      runPreparedReply → … → queueEmbeddedPiMessage(…) / runReplyAgent path
  → gateway/agent/pipeline/reply/agent-runner.ts
      runReplyAgent → runAgentTurnWithFallback → queueEmbeddedPiMessage(…) (gateway/runtime/pi-embedded.js)
  → gateway/runtime/pi-embedded-runner/run.ts
      runEmbeddedPiAgent (exported from pi-embedded.ts) → runEmbeddedAttempt(…)
  → gateway/runtime/pi-embedded-runner/run/attempt.ts
      runEmbeddedAttempt → buildEmbeddedSystemPrompt(…) → createSystemPromptOverride(appendPrompt) → systemPromptText
      → createAgentSession(…) → applySystemPromptOverrideToSession(session, systemPromptText)
      → session.agent.streamFn (Pi API) with full system prompt
```

So: **every** message goes through `getReplyFromConfig` → `runPreparedReply` → `runReplyAgent` → `runEmbeddedPiAgent` → `runEmbeddedAttempt`, which **always** builds the full embedded system prompt in `attempt.ts` and never switches to a smaller “Phase 1” or “simple” prompt.

---

## 2. Where the “massive” system prompt is built

| Step               | File                                                  | What happens                                                                                                                                                     |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build params       | `gateway/runtime/pi-embedded-runner/run/attempt.ts`   | `buildSystemPromptParams`, `buildEmbeddedSystemPrompt(...)` (tools, skills, runtime info, sandbox, model aliases, etc.).                                         |
| Prompt text        | Same file                                             | `appendPrompt = buildEmbeddedSystemPrompt(...)`; `systemPromptOverride = createSystemPromptOverride(appendPrompt)`; `systemPromptText = systemPromptOverride()`. |
| Applied to session | Same file                                             | `applySystemPromptOverrideToSession(session, systemPromptText)` before streaming.                                                                                |
| Embedding builder  | `gateway/runtime/pi-embedded-runner/system-prompt.ts` | `createSystemPromptOverride` wraps `buildAgentSystemPrompt` from `gateway/runtime/system-prompt.ts`.                                                             |

So the “massive” prompt is the **embedded agent** system prompt (persona, tools, skills, workspace, runtime, etc.) built in **runtime** (pi-embedded-runner + system-prompt.ts), not in agent/pipeline.

---

## 3. Where the “small” system prompt lives (and why it’s not used)

- **Small prompt (Phase 1 classifier):**  
  `gateway/agent/system-prompts-by-stage.ts` → `PHASE_1_CLASSIFIER_SYSTEM_PROMPT` / `getSystemPromptForStage("classify")`.  
  Intended for: “Classify this user message as **stay** (handle here with minimal prompt) or **escalate** (hand off to full agent).”

- **Phase 1 decision (heuristic only):**  
  `gateway/agent/pipeline/reply/phases/routing/phase-1.ts` → `phase1Classify({ body })` → `{ decision: "stay" | "escalate" }`.  
  No LLM is called here; it’s regex + length rules (e.g. “hi” → short, no `?` → **stay**).

- **Request router (model override only):**  
  `gateway/agent/pipeline/reply/request-router.ts` → `routeRequest(...)` uses `phase1Classify` and, when config enables routing and a classifier model is set, returns **provider/model** for “stay” (tier: simple).  
  It does **not** return a different prompt or a “use minimal prompt” flag.

- **Critical gap:**  
  `routeRequest` is **never called** from the get-reply path. So:
  - No model override for “stay” (routing not applied).
  - No “tier” or “simple” flag is passed to the runner.
  - The runner has no way to choose “small prompt for simple input”; it always builds the full prompt in `attempt.ts`.

So the small prompt exists and is designed for Phase 1, but:

1. Phase 1 is heuristic-only (no LLM with `PHASE_1_CLASSIFIER_SYSTEM_PROMPT`).
2. Tiered routing (`routeRequest`) is not wired into the reply pipeline.
3. Even if it were, only provider/model would change; the pipeline does not pass “use minimal prompt” into the runtime, and the runtime does not support a “simple” prompt mode.

---

## 4. What would need to change to use the small prompt for “hi”

1. **Wire tiered routing into get-reply**  
   In `get-reply.ts` or `get-reply-directives.ts`, after resolving directives and before `runPreparedReply`:
   - Call `routeRequest({ cleanedBody, sessionKey, provider, model, cfg, defaultProvider, aliasIndex })`.
   - If result is `useDefault: false` and `tier: "simple"`, either:
     - Use the returned provider/model (already in the design), and
     - Pass a flag into the run path, e.g. `replyTier: "simple"`.

2. **Use tier in the runner**  
   In `gateway/agent/pipeline/reply/get-reply-run.ts` / `agent-runner.ts`, pass `replyTier` (or similar) through to `runEmbeddedPiAgent`.

3. **Support “simple” prompt in runtime**  
   In `gateway/runtime/pi-embedded-runner/run/attempt.ts` (or params to it):
   - If tier is “simple”, either:
     - Build a minimal system prompt (e.g. a short “you are a helpful assistant” style prompt, or a dedicated “simple reply” prompt), or
     - Call the agent’s Phase 1 prompt (e.g. `getSystemPromptForStage("classify")`) only when we eventually use an LLM for classification; for “simple reply” we’d more likely want a **reply** prompt, not the classifier prompt.
   - Otherwise, keep current behavior (full `buildEmbeddedSystemPrompt`).

So: the small prompt you added is the **classifier** prompt; for “hi” we’d want a **small reply** path (same idea: minimal prompt, no full tools/persona). The flow doc above shows exactly where to branch (after routing, in get-reply-run) and where the big prompt is built (attempt.ts) so you can add that branch and a minimal-prompt mode.

---

## 5. Agent vs runtime: who owns what

- **Agent (pipeline):** Decides _what_ to do: classify (stay vs escalate), which model to use, and whether this turn should use “simple” vs “full” reply. Owns Phase 1, request router, and the idea of “tier” or “simple” vs “complex”.
- **Runtime (pi-embedded-runner):** Executes the run: session, model API, tools, and **building the system prompt** from params. It should not decide “is this simple?”; it should accept a hint (e.g. `promptMode: "simple" | "full"`) and build either a minimal or full prompt accordingly.

So the “feature” of “use small prompt for easy inputs” is mostly **agent** (pipeline) responsibility; the **runtime** just needs to support a “simple” prompt mode when the pipeline says so.
