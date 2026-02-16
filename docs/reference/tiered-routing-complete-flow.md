---
summary: "Complete code flow for simple and complex tier routing with file locations"
read_when:
  - Reviewing the tiered routing implementation
  - Refactoring or reorganizing reply pipeline code
  - Understanding where each piece of logic lives
title: "Tiered Routing: Complete Code Flow"
---

# Tiered routing: Complete code flow

This doc maps the **complete end-to-end flow** for both **simple** and **complex** tiers, with exact file locations for every step.

---

## Overview: Two execution paths

Every incoming message goes through **Phase 1 routing** which classifies it as "simple" or "complex". After that, the execution splits into two distinct paths:

- **Simple tier (fast path):** No session, minimal prompt, no tools, direct completion
- **Complex tier (full agent):** Full system prompt, session, tools, streaming

---

## Complete flow diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. MESSAGE ARRIVAL                                                      │
│ FILE: gateway/server/server/ws-connection/message-handler.ts           │
│   - WebSocket message received (e.g. TUI "hi")                         │
│   - handleGatewayRequest                                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. SERVER METHOD DISPATCH                                              │
│ FILE: gateway/server/server-methods.ts                                 │
│   - Routes to handler based on req.method                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. CHAT HANDLER                                                        │
│ FILE: gateway/server/server-methods/chat.ts                           │
│   - chatHandlers.run                                                   │
│   - Builds MsgContext                                                  │
│   - Calls dispatchInboundMessage({ ctx, cfg, dispatcher })             │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. PIPELINE DISPATCH                                                   │
│ FILE: gateway/agent/pipeline/dispatch.ts                              │
│   - dispatchInboundMessage                                             │
│   - finalizeInboundContext                                             │
│   - dispatchReplyFromConfig({ replyResolver: getReplyFromConfig })     │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. REPLY DISPATCH WRAPPER                                              │
│ FILE: gateway/agent/pipeline/reply/dispatch-from-config.ts             │
│   - dispatchReplyFromConfig                                            │
│   - Calls replyResolver (getReplyFromConfig)                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 6. REPLY RESOLVER (Main Logic)                                         │
│ FILE: gateway/agent/pipeline/reply/reply-building/get-reply.ts         │
│   - getReplyFromConfig(ctx, opts, cfg)                                 │
│   - resolveReplyDirectives → handles inline directives                 │
│   - handleInlineActions → processes inline actions                     │
│   - stageSandboxMedia → prepares media attachments                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 7. PHASE 1 ROUTING (Tier Decision)                                    │
│ FILE: gateway/agent/pipeline/reply/reply-building/get-reply.ts         │
│   - Calls routeRequest({ cleanedBody, sessionKey, provider, ... })     │
│                                                                         │
│   ┌───────────────────────────────────────────────────────────────┐   │
│   │ 7a. REQUEST ROUTER                                            │   │
│   │ FILE: gateway/agent/pipeline/reply/agent-runner/routing/      │   │
│   │       request-router.ts                                       │   │
│   │   - Calls phase1Classify({ body, cfg })                       │   │
│   │   ┌───────────────────────────────────────────────────────┐   │   │
│   │   │ 7b. PHASE 1 CLASSIFIER                                │   │   │
│   │   │ FILE: gateway/agent/pipeline/reply/agent-runner/      │   │   │
│   │   │       phases/routing/phase-1.ts                       │   │   │
│   │   │   - Makes LLM call with PHASE_1_CLASSIFIER_SYSTEM_    │   │   │
│   │   │     PROMPT                                            │   │   │
│   │   │     (from gateway/agent/system-prompts-by-stage.ts)   │   │   │
│   │   │   - Returns: { decision: "stay" | "escalate" }        │   │   │
│   │   └───────────────────────────────────────────────────────┘   │   │
│   │   - Applies routing config                                     │   │
│   │   - Returns: { tier: "simple" | "complex", provider, model }   │   │
│   └───────────────────────────────────────────────────────────────┘   │
│                                                                         │
│   - Receives tier decision: "simple" or "complex"                      │
│   - Calls runPreparedReply({ provider, model, replyTier, ... })       │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 8. RUN PREPARED REPLY                                                  │
│ FILE: gateway/agent/pipeline/reply/reply-building/get-reply-run.ts     │
│   - runPreparedReply({ ..., replyTier })                               │
│   - Calls runReplyAgent({ ..., replyTier })                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 9. AGENT RUNNER                                                        │
│ FILE: gateway/agent/pipeline/reply/agent-runner/core/agent-runner.ts   │
│   - runReplyAgent({ ..., replyTier })                                  │
│   - runAgentTurnWithFallback({ ..., replyTier })                       │
│   - Calls queueEmbeddedPiMessage({ ..., replyTier, ... })              │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 10. EMBEDDED PI RUNNER ENTRY                                           │
│ FILE: gateway/runtime/pi-embedded-runner/run.ts                        │
│   - runEmbeddedPiAgent({ ..., replyTier })                             │
│   - Calls runEmbeddedAttempt({ ..., replyTier })                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 11. TIER BRANCHING POINT                                               │
│ FILE: gateway/runtime/pi-embedded-runner/run/attempt.ts                │
│   - runEmbeddedAttempt({ ..., replyTier })                             │
│   - Checks replyTier value                                             │
└─────────────────────────────────────────────────────────────────────────┘
                    ↓                                    ↓
       ┌────────────────────┐                ┌────────────────────┐
       │ tier === "simple"  │                │ tier === "complex" │
       │                    │                │  (or undefined)    │
       └────────────────────┘                └────────────────────┘
                    ↓                                    ↓
┌─────────────────────────────────┐      ┌─────────────────────────────────┐
│ 12a. SIMPLE PATH                │      │ 12b. COMPLEX PATH               │
│ (Fast path, no session)         │      │ (Full agent with session)       │
└─────────────────────────────────┘      └─────────────────────────────────┘
```

---

## 12a. Simple path (tier === "simple")

**File:** `gateway/runtime/pi-embedded-runner/run/attempt.ts`

```
runSimpleTierFastPath({ promptText, model, provider, ... })
  ↓
No session creation
No system prompt building
No tools loading
  ↓
completeSimple(promptText)
  - Direct LLM call with minimal/no prompt
  - User message sent directly or with tiny wrapper
  ↓
Returns simple text reply
  ↓
Response flows back through:
  - attempt.ts → run.ts → agent-runner.ts → get-reply-run.ts
  - Reply delivered to user via channel
```

### Simple path: What's skipped

- ❌ No session creation (`createAgentSession`)
- ❌ No full system prompt (`buildEmbeddedSystemPrompt`)
- ❌ No tools loading
- ❌ No skills loading
- ❌ No workspace context
- ❌ No streaming
- ✅ Just: direct `completeSimple()` call with user message

---

## 12b. Complex path (tier === "complex") - DETAILED

**File:** `gateway/runtime/pi-embedded-runner/run/attempt.ts`

This is the full agent path - much more comprehensive than the simple path. Here's every step:

```
runEmbeddedAttempt (entry point - line ~291)
  │
  ├─ Check: if (params.replyTier === "simple") → fast path (covered in 12a)
  │
  └─ Complex path continues...
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Workspace & Environment Setup (lines ~308-345)                │
│ FILE: gateway/runtime/pi-embedded-runner/run/attempt.ts                │
│                                                                         │
│ 1. Create workspace directory (mkdir -p)                               │
│ 2. Resolve sandbox context (resolveSandboxContext)                     │
│    - Determines if sandboxed execution is enabled                      │
│    - Sets workspace access mode (rw or ro)                             │
│ 3. Load skill entries (loadWorkspaceSkillEntries)                      │
│    - Scans workspace for SKILL.md files                                │
│    - Loads skill metadata and descriptions                             │
│ 4. Apply skill environment overrides (applySkillEnvOverrides)          │
│    - Sets env vars from skills                                         │
│ 5. Resolve skills prompt (resolveSkillsPromptForRun)                   │
│    - Builds <available_skills> section for system prompt               │
│ 6. Resolve bootstrap context (resolveBootstrapContextForRun)           │
│    - Reads BOOTSTRAP.md and other context files                        │
│    - Runs before_agent_start hooks                                     │
│    - Returns: bootstrapFiles, contextFiles                             │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Tools & Capabilities Setup (lines ~366-473)                   │
│                                                                         │
│ 7. Create OpenClaw coding tools (createOpenClawCodingTools)            │
│    FILE: gateway/runtime/pi-tools.ts                                   │
│    - Shell execution tool                                              │
│    - File operations (read, write, search, etc.)                       │
│    - Memory tools (memory_search, memory_get)                          │
│    - Messaging tools (message_send, etc.)                              │
│    - Task management tools                                             │
│    - Browser tools (if enabled)                                        │
│    - Git tools, screenshot tools, etc.                                 │
│                                                                         │
│ 8. Sanitize tools for provider (sanitizeToolsForGoogle)                │
│    - Google/Gemini: removes unsupported tool features                  │
│    - Anthropic/OpenAI: passes through unchanged                        │
│                                                                         │
│ 9. Resolve channel capabilities                                        │
│    - Telegram: reactions, inline buttons, etc.                         │
│    - Signal: reactions                                                 │
│    - Discord: reactions, threads, etc.                                 │
│    - Returns: capabilities array for runtime info                      │
│                                                                         │
│ 10. Resolve channel message actions                                    │
│     - listChannelSupportedActions: react, edit, unsend, etc.           │
│     - resolveChannelMessageToolHints: usage hints for message tool     │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: System Prompt Building (lines ~475-560)                       │
│                                                                         │
│ 11. Build system prompt parameters (buildSystemPromptParams)           │
│     FILE: gateway/runtime/system-prompt-params.ts                      │
│     Collects:                                                           │
│     - runtimeInfo: host, OS, arch, Node version, model, channel        │
│     - userTimezone, userTime, userTimeFormat                           │
│     - Resolves from config and environment                             │
│                                                                         │
│ 12. Build embedded system prompt (buildEmbeddedSystemPrompt)           │
│     FILE: gateway/runtime/pi-embedded-runner/system-prompt.ts          │
│     → Calls buildAgentSystemPrompt                                     │
│       FILE: gateway/runtime/system-prompt.ts                           │
│       Builds sections:                                                  │
│       ├─ Identity line: "You are OpenClaw..."                          │
│       ├─ Skills section (if skills present)                            │
│       ├─ Memory section (if memory tools available)                    │
│       ├─ User identity (owner numbers)                                 │
│       ├─ Date & time                                                   │
│       ├─ Reply tags ([[reply_to_current]])                             │
│       ├─ Messaging section                                             │
│       ├─ TTS hints                                                     │
│       ├─ Reaction guidance                                             │
│       ├─ Heartbeat section                                             │
│       ├─ Workspace section (workspace dir, notes)                      │
│       ├─ Tooling section (tool summaries by category)                  │
│       ├─ Sandbox section (if sandboxed)                                │
│       ├─ Runtime section (host, OS, model, channel, capabilities)      │
│       ├─ Model aliases                                                 │
│       ├─ Think level guidance                                          │
│       ├─ Reasoning level guidance                                      │
│       ├─ Context files (BOOTSTRAP.md, injected files)                  │
│       └─ Extra system prompt (from config)                             │
│                                                                         │
│ 13. Create system prompt override (createSystemPromptOverride)         │
│     - Wraps the prompt text in a function                              │
│     - Returns systemPromptText (full prompt string)                    │
│                                                                         │
│ 14. Build system prompt report (buildSystemPromptReport)               │
│     - Saves prompt metadata for debugging/auditing                     │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Session Management Setup (lines ~562-615)                     │
│                                                                         │
│ 15. Acquire session write lock (acquireSessionWriteLock)               │
│     - Prevents concurrent writes to session file                       │
│                                                                         │
│ 16. Repair session file if needed (repairSessionFileIfNeeded)          │
│     - Fixes corrupted JSON                                             │
│     - Removes invalid entries                                          │
│                                                                         │
│ 17. Resolve transcript policy (resolveTranscriptPolicy)                │
│     - Model-specific validation rules                                  │
│     - Anthropic: validateAnthropicTurns                                │
│     - Gemini: validateGeminiTurns                                      │
│                                                                         │
│ 18. Open session manager (SessionManager.open)                         │
│     - Loads existing session from file                                 │
│     - Wraps with guardSessionManager (security/validation layer)       │
│                                                                         │
│ 19. Prepare session manager for run (prepareSessionManagerForRun)      │
│     - Initialize if new session                                        │
│     - Set session metadata                                             │
│                                                                         │
│ 20. Configure settings manager (SettingsManager.create)                │
│     - Context pruning settings                                         │
│     - Compaction reserve tokens                                        │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: Session Creation (lines ~619-653)                             │
│                                                                         │
│ 21. Split tools (splitSdkTools)                                        │
│     - builtInTools: Shell, FileSystem, etc. (core tools)               │
│     - customTools: Memory, Message, Browser, etc. (OpenClaw tools)     │
│                                                                         │
│ 22. Add client tools (toClientToolDefinitions)                         │
│     - Hosted tools from OpenResponses                                  │
│     - Appends to customTools                                           │
│                                                                         │
│ 23. Create agent session (createAgentSession)                          │
│     FROM: @mariozechner/pi-coding-agent                                │
│     Parameters:                                                         │
│     - model: { provider, model, api }                                  │
│     - thinkingLevel: "off" | "low" | "medium" | "high"                │
│     - tools: builtInTools (Shell, FileSystem, etc.)                    │
│     - customTools: OpenClaw tools + client tools                       │
│     - sessionManager: session file manager                             │
│     - settingsManager: pruning/compaction settings                     │
│     Returns: { session, ... }                                          │
│     - session.agent: the Pi agent instance                             │
│     - session.messages: conversation history                           │
│     - session.sessionId: unique session identifier                     │
│                                                                         │
│ 24. Apply system prompt to session (applySystemPromptOverrideToSession)│
│     - Injects systemPromptText into session                            │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 6: History & Caching Setup (lines ~660-740)                      │
│                                                                         │
│ 25. Create cache trace (createCacheTrace)                              │
│     - Logs cache hits/misses for debugging                             │
│     - Wraps streamFn to track cache usage                              │
│                                                                         │
│ 26. Create Anthropic payload logger (createAnthropicPayloadLogger)     │
│     - Logs full request/response for Anthropic models                  │
│     - Wraps streamFn for debugging                                     │
│                                                                         │
│ 27. Apply extra params to agent (applyExtraParamsToAgent)              │
│     - temperature, top_p, top_k, etc.                                  │
│     - Model-specific parameters from config                            │
│                                                                         │
│ 28. Sanitize session history (sanitizeSessionHistory)                  │
│     - Remove invalid messages                                          │
│     - Fix malformed tool calls                                         │
│     - Validate turn ordering (user → assistant → user)                 │
│                                                                         │
│ 29. Validate history (validateGeminiTurns / validateAnthropicTurns)    │
│     - Model-specific validation                                        │
│     - Fixes consecutive same-role messages                             │
│                                                                         │
│ 30. Limit history turns (limitHistoryTurns)                            │
│     - Truncates to max_history_turns from config                       │
│     - Keeps most recent messages                                       │
│                                                                         │
│ 31. Repair tool pairing (sanitizeToolUseResultPairing)                 │
│     - Ensures every tool_use has a matching tool_result                │
│     - Removes orphaned tool_results                                    │
│                                                                         │
│ 32. Replace messages in agent (session.agent.replaceMessages)          │
│     - Updates agent's internal message list                            │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 7: Streaming & Event Subscription (lines ~797-829)               │
│                                                                         │
│ 33. Subscribe to session events (subscribeEmbeddedPiSession)           │
│     FILE: gateway/runtime/pi-embedded-subscribe.ts                     │
│     Attaches event handlers for:                                       │
│     - onPartialReply: streaming text chunks                            │
│     - onBlockReply: complete text blocks                               │
│     - onToolResult: tool execution results                             │
│     - onReasoningStream: <thinking> blocks                             │
│     - onAgentEvent: all agent lifecycle events                         │
│     - onAssistantMessageStart: new message started                     │
│     Returns:                                                            │
│     - assistantTexts: array of reply text chunks                       │
│     - toolMetas: array of tool call metadata                           │
│     - unsubscribe: cleanup function                                    │
│     - getMessagingToolSentTexts: messages sent via message_send        │
│     - getLastToolError: most recent tool error                         │
│     - getUsageTotals: token usage stats                                │
│                                                                         │
│ 34. Set active embedded run (setActiveEmbeddedRun)                     │
│     - Registers run in global registry                                 │
│     - Enables queueing additional messages mid-stream                  │
│     - Provides abort() function for cancellation                       │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 8: Timeout & Abort Setup (lines ~841-882)                        │
│                                                                         │
│ 35. Set timeout timer (setTimeout)                                     │
│     - Default: 600,000ms (10 minutes)                                  │
│     - Calls abortRun(true) when timeout expires                        │
│                                                                         │
│ 36. Attach external abort signal listener                              │
│     - Listens to params.abortSignal                                    │
│     - Allows caller to cancel run externally                           │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 9: Prompt Execution (lines ~894-1009)                            │
│                                                                         │
│ 37. Run before_agent_start hooks (hookRunner.runBeforeAgentStart)      │
│     - Allows plugins to inject context into prompt                     │
│     - Can prepend additional context to user message                   │
│                                                                         │
│ 38. Log model input                                                    │
│     - System prompt length                                             │
│     - Message count                                                    │
│     - User prompt text (truncated unless verbose)                      │
│                                                                         │
│ 39. Repair orphaned user messages                                      │
│     - Removes trailing user message if present                         │
│     - Prevents consecutive user turns                                  │
│                                                                         │
│ 40. Detect and load prompt images (detectAndLoadPromptImages)          │
│     FILE: gateway/runtime/pi-embedded-runner/run/images.ts             │
│     - Scans prompt for @image(path) references                         │
│     - Loads images from disk (respects sandbox restrictions)           │
│     - Scans history for image references (enables "compare to first")  │
│     - Returns: images array + historyImagesByIndex map                 │
│                                                                         │
│ 41. Inject history images (injectHistoryImagesIntoMessages)            │
│     - Adds images to their original message positions                  │
│     - Enables follow-up questions about earlier images                 │
│                                                                         │
│ 42. Call agent prompt (session.prompt)                                 │
│     FROM: @mariozechner/pi-coding-agent                                │
│     → session.agent.streamFn(...)                                      │
│       FROM: @mariozechner/pi-ai (streamSimple)                         │
│       Makes actual LLM API call:                                       │
│       - Anthropic: /v1/messages (streaming)                            │
│       - OpenAI: /v1/chat/completions (streaming)                       │
│       - Google: /v1/models/${model}:streamGenerateContent              │
│       - Sends: system prompt, messages, tools, images                  │
│       - Receives: streaming response chunks                            │
│       - Executes: tool calls as they arrive                            │
│       - Returns: final assistant message                               │
│                                                                         │
│ 43. Wait for compaction retry (waitForCompactionRetry)                 │
│     - If context exceeded during streaming                             │
│     - Compacts history and retries                                     │
│                                                                         │
│ 44. Append cache-TTL timestamp (appendCacheTtlTimestamp)               │
│     - For cache-ttl pruning mode                                       │
│     - Tracks when messages were added                                  │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 10: Response Processing (lines ~1039-1100)                       │
│                                                                         │
│ 45. Extract assistant text (extractAssistantText)                      │
│     - Joins all text chunks from streaming                             │
│     - Filters out [[reply_to_current]] tags                            │
│                                                                         │
│ 46. Check messaging tool usage (didSendViaMessagingTool)               │
│     - If message_send was used                                         │
│     - Returns early (no reply to original channel)                     │
│                                                                         │
│ 47. Check for client tool calls (clientToolCallDetected)               │
│     - If OpenResponses hosted tool was called                          │
│     - Returns tool call metadata                                       │
│                                                                         │
│ 48. Check for [[SILENT]] token                                         │
│     - If present, return empty reply                                   │
│     - Used for actions that don't need a text response                 │
│                                                                         │
│ 49. Get usage totals (getUsageTotals)                                  │
│     - Input tokens                                                     │
│     - Output tokens                                                    │
│     - Cache hits/misses (if supported)                                 │
│                                                                         │
│ 50. Clear active run (clearActiveEmbeddedRun)                          │
│     - Removes from global registry                                     │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 11: Cleanup & Return (lines ~1100-1143)                          │
│                                                                         │
│ 51. Unsubscribe from events (unsubscribe)                              │
│     - Removes all event listeners                                      │
│                                                                         │
│ 52. Dispose session (session.dispose)                                  │
│     - Closes session resources                                         │
│                                                                         │
│ 53. Release session lock (sessionLock.release)                         │
│     - Allows other runs to access session                              │
│                                                                         │
│ 54. Restore skill environment (restoreSkillEnv)                        │
│     - Restores original env vars                                       │
│                                                                         │
│ 55. Restore working directory (process.chdir)                          │
│     - Returns to original cwd                                          │
│                                                                         │
│ 56. Return result (EmbeddedRunAttemptResult)                           │
│     {                                                                   │
│       ok: true,                                                         │
│       reply: assistantText,                                             │
│       sessionIdUsed: string,                                            │
│       messagesSnapshot: AgentMessage[],                                 │
│       toolResults: toolMetas,                                           │
│       systemPromptReport: {...},                                        │
│       usage: { inputTokens, outputTokens, ... },                       │
│       ...                                                               │
│     }                                                                   │
└─────────────────────────────────────────────────────────────────────────┘
     ↓
Response flows back through:
  attempt.ts (result) →
  run.ts (runEmbeddedPiAgent) →
  agent-runner.ts (runAgentTurnWithFallback) →
  get-reply-run.ts (runPreparedReply) →
  get-reply.ts (getReplyFromConfig) →
  dispatch-from-config.ts (dispatchReplyFromConfig) →
  dispatch.ts (dispatchInboundMessage) →
  chat.ts (chatHandlers.run) →
  WebSocket → User
```

### Complex path: What's included (56 steps!)

**Core infrastructure:**

- ✅ Full session creation & management
- ✅ Session file locking (prevents concurrent writes)
- ✅ Session history sanitization & validation
- ✅ Session repair (fixes corrupted JSON)

**System prompt:**

- ✅ Complete system prompt with 15+ sections
- ✅ Tool summaries categorized by purpose
- ✅ Skills section with <available_skills>
- ✅ Workspace context (BOOTSTRAP.md, etc.)
- ✅ Runtime info (OS, host, model, channel, capabilities)
- ✅ Memory section (if memory tools present)
- ✅ User identity (owner numbers)
- ✅ Heartbeat section
- ✅ Sandbox section (if sandboxed)
- ✅ Model aliases
- ✅ Think level & reasoning guidance

**Tools:**

- ✅ All tools available (~20+ tools)
- ✅ Shell execution
- ✅ File operations (read, write, search, etc.)
- ✅ Memory tools (memory_search, memory_get)
- ✅ Messaging tools (message_send, etc.)
- ✅ Browser tools
- ✅ Git tools
- ✅ Screenshot tools
- ✅ Task management
- ✅ Client tools (OpenResponses hosted)

**Features:**

- ✅ Streaming enabled
- ✅ Tool execution enabled
- ✅ Image detection & loading (vision models)
- ✅ History image injection (follow-up questions)
- ✅ Context pruning & compaction
- ✅ Cache tracking (Anthropic prompt caching)
- ✅ Plugin hooks (before_agent_start, etc.)
- ✅ Abort support (timeout + external signal)
- ✅ Token usage tracking
- ✅ Error handling & failover

### Performance comparison

| Aspect        | Simple Tier         | Complex Tier                    |
| ------------- | ------------------- | ------------------------------- |
| Steps         | 7 steps             | **56 steps**                    |
| Session file  | ❌ Not accessed     | ✅ Read, lock, write            |
| Tools         | ❌ None             | ✅ 20+ tools loaded             |
| System prompt | Minimal (~50 chars) | Full (~50K+ chars)              |
| History       | ❌ No history       | ✅ Full history with validation |
| Images        | ❌ Not supported    | ✅ Auto-detected & loaded       |
| Streaming     | ❌ No streaming     | ✅ Full streaming               |
| Plugins       | ❌ No hooks         | ✅ Hook support                 |
| Latency       | ~200-500ms          | ~2000-5000ms                    |

The complex path is **~10x slower** but provides the full agent experience with all tools, history, and capabilities.

---

## Key files summary

### Phase 1 Classification (Decides tier)

| File                                                                  | Purpose                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `gateway/agent/system-prompts-by-stage.ts`                            | Contains `PHASE_1_CLASSIFIER_SYSTEM_PROMPT`                         |
| `gateway/agent/pipeline/reply/agent-runner/phases/routing/phase-1.ts` | LLM-based classification: returns "stay" or "escalate"              |
| `gateway/agent/pipeline/reply/agent-runner/routing/request-router.ts` | Orchestrates Phase 1, applies config, returns tier + provider/model |

### Pipeline Flow (Both tiers)

| File                                                             | Purpose                                    |
| ---------------------------------------------------------------- | ------------------------------------------ |
| `gateway/server/server/ws-connection/message-handler.ts`         | WebSocket message handler                  |
| `gateway/server/server-methods.ts`                               | Method dispatch router                     |
| `gateway/server/server-methods/chat.ts`                          | Chat handler, builds MsgContext            |
| `gateway/agent/pipeline/dispatch.ts`                             | Pipeline entry: `dispatchInboundMessage`   |
| `gateway/agent/pipeline/reply/dispatch-from-config.ts`           | Reply dispatch wrapper                     |
| `gateway/agent/pipeline/reply/reply-building/get-reply.ts`       | Main resolver: calls routing, builds reply |
| `gateway/agent/pipeline/reply/reply-building/get-reply-run.ts`   | Executes prepared reply                    |
| `gateway/agent/pipeline/reply/agent-runner/core/agent-runner.ts` | Agent runner: `runReplyAgent`              |

### Runtime (Tier branching + execution)

| File                                                  | Purpose                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `gateway/runtime/pi-embedded-runner/run.ts`           | Runtime entry: `runEmbeddedPiAgent`                                          |
| `gateway/runtime/pi-embedded-runner/run/attempt.ts`   | **BRANCHING POINT**: checks `replyTier` and routes to simple or complex path |
| `gateway/runtime/pi-embedded-runner/system-prompt.ts` | System prompt building (complex tier only)                                   |

### Simple Tier (Fast path)

| File                                                | Function                | What it does                        |
| --------------------------------------------------- | ----------------------- | ----------------------------------- |
| `gateway/runtime/pi-embedded-runner/run/attempt.ts` | `runSimpleTierFastPath` | Entry point for simple tier         |
| `gateway/runtime/pi-embedded-runner/run/attempt.ts` | `completeSimple`        | Direct LLM call with minimal prompt |

### Complex Tier (Full agent)

| File                                                  | Function                             | What it does                           |
| ----------------------------------------------------- | ------------------------------------ | -------------------------------------- |
| `gateway/runtime/pi-embedded-runner/run/attempt.ts`   | `buildSystemPromptParams`            | Collects all context for system prompt |
| `gateway/runtime/pi-embedded-runner/system-prompt.ts` | `buildEmbeddedSystemPrompt`          | Builds full system prompt              |
| `gateway/runtime/pi-embedded-runner/system-prompt.ts` | `createSystemPromptOverride`         | Wraps prompt builder                   |
| `gateway/runtime/pi-embedded-runner/run/attempt.ts`   | `createAgentSession`                 | Creates Pi agent session               |
| `gateway/runtime/pi-embedded-runner/run/attempt.ts`   | `applySystemPromptOverrideToSession` | Injects system prompt                  |

---

## Decision point summary

| Stage                | File                                                                  | Decision/Action                                                      |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Phase 1 LLM call** | `gateway/agent/pipeline/reply/agent-runner/phases/routing/phase-1.ts` | Classifies message as "stay" or "escalate"                           |
| **Tier assignment**  | `gateway/agent/pipeline/reply/agent-runner/routing/request-router.ts` | Converts decision to tier: "stay" → "simple", "escalate" → "complex" |
| **Tier propagation** | All pipeline files                                                    | `replyTier` passed through function signatures                       |
| **Tier branching**   | `gateway/runtime/pi-embedded-runner/run/attempt.ts`                   | `if (replyTier === "simple")` → fast path, else → full agent         |

---

## Testing

**E2E tests:** `gateway/agent/pipeline/reply/e2e/tiered-routing.e2e.test.ts`

Tests cover:

- Phase 1 classification decisions
- Simple tier execution (no session, no tools)
- Complex tier execution (full agent)
- Router config application
- Provider/model overrides

---

## Next steps for review

Use this doc to:

1. **Verify file organization:** Is each piece of logic in the right file?
2. **Check separation of concerns:** Is pipeline (decision) vs runtime (execution) clean?
3. **Identify refactoring opportunities:** Are there duplicated concerns or unclear boundaries?
4. **Plan reorganization:** What should move, merge, or split?

See also:

- [Message-to-reply flow](/reference/message-to-reply-flow) — Detailed flow with code snippets
- [Tiered model routing](/reference/tiered-model-routing) — Design and implementation status
- [Reply lifecycle](/reference/reply-lifecycle) — Overall pipeline organization
