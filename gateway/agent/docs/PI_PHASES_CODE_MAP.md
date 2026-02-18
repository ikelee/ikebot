# Pi 11 Phases / 56 Steps – Code Map

Code pointers for each phase so you can optimize based on classification (e.g. calendar vs full complex).

**Note:** The simple-tier branch in `runEmbeddedAttempt` is **dead**. Simple path is handled by `SimpleResponder` in `runAgentFlow` before `runPreparedReply` is ever called. `runEmbeddedAttempt` is only used for complex/calendar. The `buildSimpleSystemPrompt` import in `attempt.ts` is unused.

---

## Phase 1: Workspace & Environment Setup (steps 1–6)

| Step | What                              | File:Line                                                                                              |
| ---- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1    | Create workspace directory        | `attempt.ts:205-218` – `fs.mkdir(resolvedWorkspace)`, `fs.mkdir(effectiveWorkspace)`                   |
| 2    | Resolve sandbox context           | `attempt.ts:208-217` – `resolveSandboxContext()`                                                       |
| 3    | Load skill entries                | `attempt.ts:222-225` – `loadWorkspaceSkillEntries(effectiveWorkspace)`                                 |
| 4    | Apply skill environment overrides | `attempt.ts:226-234` – `applySkillEnvOverrides()` / `applySkillEnvOverridesFromSnapshot()`             |
| 5    | Resolve skills prompt             | `attempt.ts:236-241` – `resolveSkillsPromptForRun()`                                                   |
| 6    | Resolve bootstrap context         | `attempt.ts:244-256` – `resolveBootstrapContextForRun()` → `loadWorkspaceBootstrapFiles(workspaceDir)` |

**Optimization:** For calendar agent, could skip or trim skills (step 3–5) and restrict bootstrap files (step 6). `resolveBootstrapContextForRun` uses `workspaceDir`; bootstrap comes from `gateway/runtime/workspace.ts` `loadWorkspaceBootstrapFiles()`.

---

## Phase 2: Tools & Capabilities Setup (steps 7–10)

| Step | What                                     | File:Line                                                                                |
| ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| 7    | Create OpenClaw coding tools (20+ tools) | `attempt.ts:261-299` – `createOpenClawCodingTools()`                                     |
| 8    | Sanitize tools for provider              | `attempt.ts:300-301` – `sanitizeToolsForGoogle()`                                        |
| 9    | Resolve channel capabilities             | `attempt.ts:305-327` – `resolveChannelCapabilities()`, inline buttons, reaction guidance |
| 10   | Resolve channel message actions          | `attempt.ts:328-329` – `resolveChannelMessageToolHints()` (via `messageToolHints`)       |

**Optimization:** For calendar, only need `exec` (gog). Tool creation is in `gateway/runtime/pi-tools.ts` `createOpenClawCodingTools()`. Tool policy comes from `resolveEffectiveToolPolicy()` in `gateway/runtime/pi-tools.policy.ts`. Could add `agentCfg.toolProfile: "exec-only"` or pass a tool allowlist.

---

## Phase 3: System Prompt Building (steps 11–14)

| Step | What                          | File:Line                                                              |
| ---- | ----------------------------- | ---------------------------------------------------------------------- |
| 11   | Build system prompt params    | `attempt.ts:350-394` – `buildSystemPromptParams()` (runtimeInfo, etc.) |
| 12   | Build embedded system prompt  | `attempt.ts:407-432` – `buildEmbeddedSystemPrompt()`                   |
| 13   | Create system prompt override | `attempt.ts:455-456` – `createSystemPromptOverride()`                  |
| 14   | Build system prompt report    | `attempt.ts:434-454` – `buildSystemPromptReport()`                     |

**Files:**

- `gateway/runtime/pi-embedded-runner/system-prompt.ts` – `buildEmbeddedSystemPrompt()` → `buildAgentSystemPrompt()`
- `gateway/runtime/system-prompt.ts` – `buildAgentSystemPrompt()` (tool list, skills, memory, bootstrap, time, runtime, etc.)
- `gateway/runtime/system-prompt-params.ts` – `buildSystemPromptParams()`

**Optimization:** `buildEmbeddedSystemPrompt` accepts `promptMode: "full" | "minimal" | "none"`. For calendar, use `promptMode: "minimal"` (AGENTS + TOOLS only). Bootstrap files are passed as `contextFiles`; could filter by agent (e.g. SOUL + TOOLS only for calendar).

---

## Phase 4: Session Management Setup (steps 15–20)

| Step | What                            | File:Line                                                                              |
| ---- | ------------------------------- | -------------------------------------------------------------------------------------- |
| 15   | Acquire session write lock      | `attempt.ts:458-460` – `acquireSessionWriteLock()`                                     |
| 16   | Repair session file if needed   | `attempt.ts:465-468` – `repairSessionFileIfNeeded()`                                   |
| 17   | Resolve transcript policy       | `attempt.ts:475-479` – `resolveTranscriptPolicy()`                                     |
| 18   | Open session manager            | `attempt.ts:480-487` – `SessionManager.open(params.sessionFile)`                       |
| 19   | Prepare session manager for run | `attempt.ts:489-496` – `prepareSessionManagerForRun()`                                 |
| 20   | Configure settings manager      | `attempt.ts:497-501` – `SettingsManager.create()`, `ensurePiCompactionReserveTokens()` |

**Files:** `gateway/runtime/session-write-lock.ts`, `gateway/runtime/session-file-repair.ts`, `gateway/runtime/transcript-policy.ts`, `gateway/runtime/pi-embedded-runner/session-manager-init.ts`

---

## Phase 5: Session Creation (steps 21–24)

| Step | What                            | File:Line                                                       |
| ---- | ------------------------------- | --------------------------------------------------------------- |
| 21   | Split tools (builtIn vs custom) | `attempt.ts:515-518` – `splitSdkTools()`                        |
| 22   | Add client tools                | `attempt.ts:520-535` – `toClientToolDefinitions()`              |
| 23   | Create Pi agent session         | `attempt.ts:537-549` – `createAgentSession()` (pi-coding-agent) |
| 24   | Apply system prompt to session  | `attempt.ts:551` – `applySystemPromptOverrideToSession()`       |

---

## Phase 6: History & Caching Setup (steps 25–32)

| Step  | What                                                 | File:Line                                                                                                                                                                                                   |
| ----- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 25    | Create cache trace                                   | `attempt.ts` – `createCacheTrace()` (earlier, used in prompt)                                                                                                                                               |
| 26    | Create Anthropic payload logger                      | `attempt.ts` – `createAnthropicPayloadLogger()`                                                                                                                                                             |
| 27    | Apply extra params to agent                          | `attempt.ts` – `applyExtraParamsToAgent()`                                                                                                                                                                  |
| 28–32 | Sanitize/validate/limit history, repair tool pairing | `attempt.ts` – inside `subscribeEmbeddedPiSession` / Pi session flow; `sanitizeSessionHistory()`, `limitHistoryTurns()`, `sanitizeToolUseResultPairing()` in `gateway/runtime/pi-embedded-runner/google.ts` |

**Files:** `gateway/runtime/pi-embedded-runner/google.ts` – `sanitizeSessionHistory()`, `limitHistoryTurns()` in `gateway/runtime/pi-embedded-runner/history.ts`

---

## Phase 7: Streaming & Event Subscription (steps 33–34)

| Step | What                        | File:Line                                             |
| ---- | --------------------------- | ----------------------------------------------------- |
| 33   | Subscribe to session events | `attempt.ts:560-713` – `subscribeEmbeddedPiSession()` |
| 34   | Set active embedded run     | `attempt.ts:735` – `setActiveEmbeddedRun()`           |

**File:** `gateway/runtime/pi-embedded-subscribe.ts`

---

## Phase 8: Timeout & Abort Setup (steps 35–36)

| Step | What                         | File:Line                                                                      |
| ---- | ---------------------------- | ------------------------------------------------------------------------------ |
| 35   | Set timeout timer            | `attempt.ts:739-761` – `setTimeout(abortRun, timeoutMs)`                       |
| 36   | Attach external abort signal | `attempt.ts:770-777` – `params.abortSignal.addEventListener("abort", onAbort)` |

---

## Phase 9: Prompt Execution (steps 37–44)

| Step | What                                | File:Line                                                      |
| ---- | ----------------------------------- | -------------------------------------------------------------- |
| 37   | Run before_agent_start hooks        | `attempt.ts:795-817` – `hookRunner.runBeforeAgentStart()`      |
| 38   | Log model input                     | `attempt.ts:819-829`                                           |
| 39   | Repair orphaned user messages       | `attempt.ts:833-848`                                           |
| 40   | Detect and load prompt images       | `attempt.ts:855-866` – `detectAndLoadPromptImages()`           |
| 41   | Inject history images               | `attempt.ts:871-877` – `injectHistoryImagesIntoMessages()`     |
| 42   | **Call session.prompt()** (LLM API) | `attempt.ts:893-896` – `activeSession.prompt(effectivePrompt)` |
| 43   | Wait for compaction retry           | In Pi / subscription flow                                      |
| 44   | Append cache-TTL timestamp          | `attempt.ts` – `appendCacheTtlTimestamp()`                     |

---

## Phase 10: Response Processing (steps 45–50)

| Step | What                        | File:Line                                                        |
| ---- | --------------------------- | ---------------------------------------------------------------- |
| 45   | Extract assistant text      | `attempt.ts` – `extractAssistantText()` in subscription handlers |
| 46   | Check messaging tool usage  | Subscription / `getMessagingToolSentTexts`                       |
| 47   | Check for client tool calls | `clientToolCallDetected`                                         |
| 48   | Check for [[SILENT]] token  | In payload processing                                            |
| 49   | Get usage totals            | `getUsageTotals()`                                               |
| 50   | Clear active run            | `attempt.ts:991` – `clearActiveEmbeddedRun()`                    |

---

## Phase 11: Cleanup & Return (steps 51–56)

| Step | What                      | File:Line                                        |
| ---- | ------------------------- | ------------------------------------------------ |
| 51   | Unsubscribe from events   | `unsubscribe()` from subscription                |
| 52   | Dispose session           | In finally / cleanup                             |
| 53   | Release session lock      | `sessionLock` release                            |
| 54   | Restore skill environment | `restoreSkillEnv?.()`                            |
| 55   | Restore working directory | `process.chdir(prevCwd)`                         |
| 56   | Return result             | `attempt.ts` – return `EmbeddedRunAttemptResult` |

---

## High-Impact Optimization Points

| Goal                         | Phase | Code                                                         | Change                                                 |
| ---------------------------- | ----- | ------------------------------------------------------------ | ------------------------------------------------------ |
| **Fewer tools for calendar** | 2     | `attempt.ts:261` `createOpenClawCodingTools`                 | Pass `toolProfile` or allowlist; filter tools by agent |
| **Lighter bootstrap**        | 1, 3  | `resolveBootstrapContextForRun`, `buildEmbeddedSystemPrompt` | Filter `contextFiles` by agent (e.g. SOUL+TOOLS only)  |
| **Smaller prompt**           | 3     | `buildEmbeddedSystemPrompt`                                  | Use `promptMode: "minimal"` for calendar               |
| **Skip skills**              | 1, 3  | `resolveSkillsPromptForRun`, system prompt                   | Empty skills for calendar                              |
| **Agent-specific workspace** | 1     | `workspaceDir`                                               | Already per-agent via `resolveAgentWorkspaceDir`       |

**Classification is available:** `params.agentId` and `params.sessionKey` (which encodes agentId) are in `runEmbeddedAttempt`. Router decision (`calendar` vs `complex`) is not passed through today, but `agentId` is. You can key optimizations off `agentId === "calendar"`.

**Calendar agent in config:** Ensure `agents.list` includes `{ id: "calendar", pi: { preset: "exec-only" } }` so `runCalendarReply` does not fall back to `runComplexReply` (main agent with full prompt). See [SYSTEM_PROMPT_BLOAT_ANALYSIS.md](./SYSTEM_PROMPT_BLOAT_ANALYSIS.md).
