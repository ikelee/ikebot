# Message-to-reply flow (gateway receives a message → system prompt)

This doc maps the code path from "gateway receives a message" (e.g. "hi" from TUI) to where the **system prompt** is built, showing how **tiered routing** (Phase 1) splits messages into **simple** vs **complex** paths.

---

## 1. End-to-end flow (e.g. TUI → "hi" → reply)

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
  → gateway/agent/pipeline/reply/reply-building/get-reply.ts
      getReplyFromConfig → resolveReplyDirectives → handleInlineActions → stageSandboxMedia

      ┌─ TIERED ROUTING (Phase 1) ─────────────────────────────────┐
      │ → routeRequest({ cleanedBody, sessionKey, provider, … })   │
      │   FILE: gateway/agent/pipeline/reply/agent-runner/routing/request-router.ts │
      │     → phase1Classify({ body, cfg })                         │
      │       FILE: gateway/agent/pipeline/reply/agent-runner/phases/routing/phase-1.ts │
      │         - Uses LLM call with PHASE_1_CLASSIFIER_SYSTEM_PROMPT │
      │         - Returns: { decision: "stay" | "escalate" }        │
      │     → Returns: { useDefault, tier: "simple" | "complex", … }│
      └─────────────────────────────────────────────────────────────┘

      → runPreparedReply({ provider, model, replyTier, … })
  → gateway/agent/pipeline/reply/reply-building/get-reply-run.ts
      runPreparedReply → runReplyAgent({ …, replyTier })
  → gateway/agent/pipeline/reply/agent-runner/core/agent-runner.ts
      runReplyAgent → runAgentTurnWithFallback({ …, replyTier })
      → queueEmbeddedPiMessage({ …, replyTier, … })
  → gateway/runtime/pi-embedded-runner/run.ts
      runEmbeddedPiAgent → runEmbeddedAttempt({ …, replyTier })
  → gateway/runtime/pi-embedded-runner/run/attempt.ts
      runEmbeddedAttempt checks replyTier and branches:

      ┌─ SIMPLE PATH (tier === "simple") ──────────────────────────┐
      │ → runSimpleTierFastPath({ promptText, … })                 │
      │   FILE: gateway/runtime/pi-embedded-runner/run/attempt.ts  │
      │     - No session creation                                   │
      │     - No full system prompt                                 │
      │     - No tools                                              │
      │     - Uses completeSimple(promptText) directly              │
      │     - Returns text reply                                    │
      └─────────────────────────────────────────────────────────────┘

      ┌─ COMPLEX PATH (tier === "complex" or undefined) ───────────┐
      │ → buildEmbeddedSystemPrompt(…) → full prompt with:         │
      │   FILE: gateway/runtime/pi-embedded-runner/system-prompt.ts│
      │     - Tools, skills, runtime info, workspace context        │
      │     - Sandbox, model aliases, etc.                          │
      │ → createSystemPromptOverride(appendPrompt)                 │
      │ → createAgentSession(…)                                    │
      │ → applySystemPromptOverrideToSession(session, prompt)      │
      │ → session.agent.streamFn (Pi API) with full prompt         │
      │ → Streaming response with tool calls, etc.                 │
      └─────────────────────────────────────────────────────────────┘
```

So: **every** message goes through Phase 1 routing (`routeRequest` → `phase1Classify`), which uses an **LLM call** to classify the message and returns a tier decision ("simple" or "complex"). The tier is passed all the way down to `attempt.ts`, which **branches** based on `replyTier`:

- **Simple**: Fast path with minimal prompt, no session, no tools (`runSimpleTierFastPath`)
- **Complex**: Full agent with complete system prompt, session, tools, streaming (`runEmbeddedAttempt` full path)

---

## 2. Complex path detailed breakdown (56 steps)

The complex tier goes through **11 phases** with **56 steps total**. Here's the complete breakdown:

### Phase 1: Workspace & Environment Setup

1. Create workspace directory
2. Resolve sandbox context (determines if sandboxed)
3. Load skill entries (scans for SKILL.md files)
4. Apply skill environment overrides
5. Resolve skills prompt (builds `<available_skills>` section)
6. Resolve bootstrap context (reads BOOTSTRAP.md, runs hooks)

### Phase 2: Tools & Capabilities Setup

7. Create OpenClaw coding tools (Shell, FileSystem, Memory, Message, Browser, Git, etc. - 20+ tools)
8. Sanitize tools for provider (Google/Gemini compatibility)
9. Resolve channel capabilities (reactions, inline buttons, threads, etc.)
10. Resolve channel message actions (react, edit, unsend, etc.)

### Phase 3: System Prompt Building

11. Build system prompt parameters (collects runtime info, timezone, etc.)
12. Build embedded system prompt (15+ sections: identity, skills, memory, tools, workspace, runtime, etc.)
13. Create system prompt override (wraps prompt in function)
14. Build system prompt report (saves metadata for debugging)

**File:** `gateway/runtime/pi-embedded-runner/run/attempt.ts` calls:

- `buildSystemPromptParams` → `gateway/runtime/system-prompt-params.ts`
- `buildEmbeddedSystemPrompt` → `gateway/runtime/pi-embedded-runner/system-prompt.ts`
  - Which calls `buildAgentSystemPrompt` → `gateway/runtime/system-prompt.ts`

### Phase 4: Session Management Setup

15. Acquire session write lock (prevents concurrent writes)
16. Repair session file if needed (fixes corrupted JSON)
17. Resolve transcript policy (model-specific validation rules)
18. Open session manager (loads existing session)
19. Prepare session manager for run (initialize if new)
20. Configure settings manager (pruning, compaction settings)

### Phase 5: Session Creation

21. Split tools (builtIn vs custom)
22. Add client tools (OpenResponses hosted tools)
23. **Create Pi agent session** (`createAgentSession` from `@mariozechner/pi-coding-agent`)
24. Apply system prompt to session

**What is a Pi agent?**

- Pi is a library (`@mariozechner/pi-coding-agent`) that provides an LLM agent with tool execution
- It manages: conversation history, tool calling, streaming, context pruning
- `createAgentSession` returns a `session.agent` object that wraps the LLM API
- The agent handles the LLM API call, tool execution loop, and streaming events

### Phase 6: History & Caching Setup

25. Create cache trace (logs cache hits/misses)
26. Create Anthropic payload logger
27. Apply extra params to agent (temperature, top_p, etc.)
28. Sanitize session history (remove invalid messages)
29. Validate history (model-specific validation)
30. Limit history turns (truncate to max_history_turns)
31. Repair tool pairing (ensure tool_use ↔ tool_result pairs)
32. Replace messages in agent

### Phase 7: Streaming & Event Subscription

33. Subscribe to session events (streaming chunks, tool results, reasoning, etc.)
34. Set active embedded run (registers in global registry)

### Phase 8: Timeout & Abort Setup

35. Set timeout timer (default 10 minutes)
36. Attach external abort signal listener

### Phase 9: Prompt Execution (THE ACTUAL LLM CALL)

37. Run before_agent_start hooks
38. Log model input
39. Repair orphaned user messages
40. Detect and load prompt images (for vision models)
41. Inject history images (enables "compare to first image")
42. **Call `session.prompt()`** → `session.agent.streamFn()` → **LLM API call**
    - Anthropic: `/v1/messages` (streaming)
    - OpenAI: `/v1/chat/completions` (streaming)
    - Google: `/v1/models/${model}:streamGenerateContent`
    - Sends: system prompt, messages, tools, images
    - Receives: streaming response chunks
    - Executes: tool calls as they arrive
43. Wait for compaction retry (if context exceeded)
44. Append cache-TTL timestamp (for pruning)

### Phase 10: Response Processing

45. Extract assistant text
46. Check messaging tool usage (if message_send was used)
47. Check for client tool calls
48. Check for [[SILENT]] token
49. Get usage totals (input/output tokens)
50. Clear active run

### Phase 11: Cleanup & Return

51. Unsubscribe from events
52. Dispose session
53. Release session lock
54. Restore skill environment
55. Restore working directory
56. Return result

**Performance:** ~2000-5000ms total, ~10x slower than simple tier

**Key files:**

- Main orchestration: `gateway/runtime/pi-embedded-runner/run/attempt.ts`
- System prompt: `gateway/runtime/system-prompt.ts`
- Pi agent library: `@mariozechner/pi-coding-agent` (external dependency)

---

## 3. Where the "small" system prompt lives and how it's used

- **Small prompt (Phase 1 classifier):**  
  `gateway/agent/agents/classifier/prompt.ts` → `CLASSIFIER_SYSTEM_PROMPT`.  
  Used for: LLM-based classification of user message as **stay** (simple tier) or **escalate** (complex tier).

- **Phase 1 decision (LLM-based):**  
  `gateway/agent/pipeline/reply/agent-runner/phases/routing/phase-1.ts` → `phase1Classify({ body, cfg })` → `{ decision: "stay" | "escalate" }`.  
  When enabled, this **calls an LLM** with `PHASE_1_CLASSIFIER_SYSTEM_PROMPT` to classify the message.

- **Request router (tier + model selection):**  
  `gateway/agent/pipeline/reply/agent-runner/routing/request-router.ts` → `routeRequest(...)` uses `phase1Classify` and returns:
  - `tier: "simple"` or `"complex"` based on Phase 1 decision
  - Optional provider/model override for "simple" tier (when routing is enabled in config)

- **Simple tier execution:**  
  `gateway/runtime/pi-embedded-runner/run/attempt.ts` → `runSimpleTierFastPath(...)`:
  - Receives the user's prompt text directly
  - No session creation
  - No tools
  - No full system prompt
  - Calls `completeSimple(promptText)` which uses a minimal prompt or direct completion
  - Returns a simple text reply

So the small prompt is used **twice**:

1. **During Phase 1 classification** (LLM call to decide stay vs escalate)
2. **During simple tier execution** (minimal prompt for the actual reply, or direct user message)

---

## 4. File mapping: where each piece lives

### Phase 1 Routing (Decision: simple vs complex)

| Component                  | File                                                                  | Function/Export                                       |
| -------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| Phase 1 classifier prompt  | `gateway/agent/agents/classifier/prompt.ts`                           | `CLASSIFIER_SYSTEM_PROMPT`                            |
| Phase 1 LLM classification | `gateway/agent/pipeline/reply/agent-runner/phases/routing/phase-1.ts` | `phase1Classify({ body, cfg })`                       |
| Request router             | `gateway/agent/pipeline/reply/agent-runner/routing/request-router.ts` | `routeRequest(...)`                                   |
| Routing invocation         | `gateway/agent/pipeline/reply/reply-building/get-reply.ts`            | `routeRequest(...)` called after directive resolution |
| Tier passed to runner      | `gateway/agent/pipeline/reply/reply-building/get-reply.ts`            | `runPreparedReply({ ..., replyTier })`                |

### Simple Tier Execution (Fast path)

| Component         | File                                                | Function/Export                         |
| ----------------- | --------------------------------------------------- | --------------------------------------- |
| Fast path entry   | `gateway/runtime/pi-embedded-runner/run/attempt.ts` | `runSimpleTierFastPath(...)`            |
| Simple completion | `gateway/runtime/pi-embedded-runner/run/attempt.ts` | `completeSimple(promptText)`            |
| Tier branching    | `gateway/runtime/pi-embedded-runner/run/attempt.ts` | `runEmbeddedAttempt` checks `replyTier` |

### Complex Tier Execution (Full agent)

| Component              | File                                                  | Function/Export                                        |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| System prompt building | `gateway/runtime/pi-embedded-runner/run/attempt.ts`   | `buildSystemPromptParams`, `buildEmbeddedSystemPrompt` |
| System prompt override | `gateway/runtime/pi-embedded-runner/system-prompt.ts` | `createSystemPromptOverride`                           |
| Session creation       | `gateway/runtime/pi-embedded-runner/run/attempt.ts`   | `createAgentSession`                                   |
| Tools/skills loading   | `gateway/runtime/pi-embedded-runner/run/attempt.ts`   | Various helpers + `buildEmbeddedSystemPrompt`          |
| Agent streaming        | `gateway/runtime/pi-embedded-runner/run/attempt.ts`   | `session.agent.streamFn`                               |

### Pipeline Flow (Both tiers)

| Component             | File                                                             | Function/Export                             |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| Entry point           | `gateway/agent/pipeline/reply/reply-building/get-reply.ts`       | `getReplyFromConfig`                        |
| Directive resolution  | `gateway/agent/pipeline/reply/reply-building/get-reply.ts`       | `resolveReplyDirectives`                    |
| Run prepared reply    | `gateway/agent/pipeline/reply/reply-building/get-reply-run.ts`   | `runPreparedReply`                          |
| Agent runner          | `gateway/agent/pipeline/reply/agent-runner/core/agent-runner.ts` | `runReplyAgent`, `runAgentTurnWithFallback` |
| Embedded runner entry | `gateway/runtime/pi-embedded-runner/run.ts`                      | `runEmbeddedPiAgent`                        |

---

## 5. Agent vs runtime: who owns what

- **Agent (pipeline):** Decides _what_ to do:
  - Phase 1 classification (stay vs escalate)
  - Which model to use (via request router)
  - Whether this turn uses "simple" vs "complex" tier
  - Owns: Phase 1, request router, routing config, tier decision
- **Runtime (pi-embedded-runner):** Executes the run:
  - Session creation (complex tier only)
  - Model API calls
  - Tool execution (complex tier only)
  - System prompt building (complex tier only)
  - Fast-path completion (simple tier only)
  - Accepts `replyTier` hint and branches accordingly

So the "feature" of "use small prompt for easy inputs" is a collaboration:

- **Agent** (pipeline) classifies and decides tier
- **Runtime** executes the appropriate path based on tier
