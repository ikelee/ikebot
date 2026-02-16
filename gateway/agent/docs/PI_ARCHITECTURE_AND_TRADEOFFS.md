# Pi Architecture & Tradeoff Analysis

Architecture diagram of the full Pi path and tradeoff analysis for:

1. **Conditionally heavy Pi** – Make Pi lighter when not needed, still fit the agent model
2. **Medium-strength agent** – New tier between SimpleResponder and full Pi

---

## 1. Pi Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           INBOUND MESSAGE FLOW                                            │
└─────────────────────────────────────────────────────────────────────────────────────────┘

  Message (e.g. "what's on my calendar?")
         │
         ▼
┌─────────────────────┐
│  runAgentFlow()      │  gateway/agent/run.ts
│  (single entrypoint) │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐     executeAgent()      ┌─────────────────────────────────────────┐
│  RouterAgent        │ ──────────────────────► │  decision: "stay" | "escalate" |        │
│  (classifier)        │     completeSimple()     │  "calendar"                            │
│  ~500 tokens         │     maxTokens: 128      └─────────────────────────────────────────┘
│  no tools            │
└──────────┬──────────┘
           │
           ├── tier="simple" ──────────────────────────────────────────────────────────────┐
           │                                                                                │
           │    ┌─────────────────────┐     completeSimple()     ┌──────────────────────┐   │
           │    │  SimpleResponder    │ ─────────────────────►  │  ~100–500 tokens     │   │
           │    │  Agent              │     no tools, no session │  direct reply        │   │
           │    │  maxTokens: 2048    │                         └──────────────────────┘   │
           │    └─────────────────────┘                                                      │
           │                                                                                │
           └── tier="calendar" | tier="complex" ─────────────────────────────────────────────┐
                                                                                            │
           ┌─────────────────────────────────────────────────────────────────────────────┐ │
           │  runPreparedReply() → runReplyAgent() → runAgentTurnWithFallback()           │ │
           │  → queueEmbeddedPiMessage() → runEmbeddedPiAgent()                           │ │
           └─────────────────────────────────────────────────────────────────────────────┘ │
                                                                                            │
                                                                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           PI EMBEDDED RUNNER (runEmbeddedPiAgent)                        │
│                           gateway/runtime/pi-embedded-runner/run.ts                      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  runEmbeddedAttempt()  gateway/runtime/pi-embedded-runner/run/attempt.ts                 │
│                                                                                          │
│  No branch: simple tier is handled by SimpleResponder in runAgentFlow before we get      │
│  here. runEmbeddedAttempt is ONLY used for complex/calendar → always full Pi path.       │
└─────────────────────────────────────────────────────────────────────────────────────────┘
         │
         │  (simple tier already handled by SimpleResponder above – Pi never sees it)
         │  (calendar and complex both take FULL PI PATH)
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  FULL PI PATH – 11 phases, 56 steps                                                      │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  Phase 1: Workspace & Environment (steps 1–6)                                            │
│    • mkdir workspace, resolve sandbox, load skills, apply skill env, resolve bootstrap    │
│                                                                                          │
│  Phase 2: Tools & Capabilities (steps 7–10)                                            │
│    • createOpenClawCodingTools() → 20+ tools (exec, process, read, write, edit, etc.)   │
│    • sanitize for provider, channel capabilities, message actions                         │
│                                                                                          │
│  Phase 3: System Prompt (steps 11–14)                                                   │
│    • buildSystemPromptParams, buildEmbeddedSystemPrompt                                  │
│    • Injects: bootstrap (AGENTS, SOUL, TOOLS, IDENTITY, USER, HEARTBEAT, MEMORY)         │
│    • Injects: tool list + schemas, skills, safety, docs, runtime, time, etc.             │
│    • ~10k–50k+ tokens                                                                   │
│                                                                                          │
│  Phase 4: Session Management (steps 15–20)                                              │
│    • acquire session lock, repair session file, open SessionManager                      │
│    • prepareSessionManagerForRun, settings manager                                       │
│                                                                                          │
│  Phase 5: Session Creation (steps 21–24)                                                 │
│    • createAgentSession() [pi-coding-agent]                                              │
│    • applySystemPromptOverrideToSession                                                   │
│                                                                                          │
│  Phase 6: History & Caching (steps 25–32)                                                │
│    • sanitize history, validate turns, limit history, repair tool pairing                │
│                                                                                          │
│  Phase 7–8: Streaming & Timeout (steps 33–36)                                            │
│    • subscribe to session events, set active run, timeout, abort                          │
│                                                                                          │
│  Phase 9: PROMPT EXECUTION (steps 37–44)                                                │
│    • session.prompt() → LLM API call                                                     │
│    • Tool loop: model → tool calls → execute → results → model → … until done           │
│    • 2–10+ API calls per user message                                                    │
│                                                                                          │
│  Phase 10–11: Response & Cleanup (steps 45–56)                                           │
│    • extract text, check messaging tool, usage, clear run                                │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│  OUTPUT: ReplyPayload | ReplyPayload[] | undefined                                       │
│  (text, media, usage, metadata)                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

**Phase-to-code map:** See [PI_PHASES_CODE_MAP.md](./PI_PHASES_CODE_MAP.md) for exact file:line for all 11 phases and optimization points.

---

## 2. What Makes Pi Heavy (Summary)

| Component          | Weight                                 | Notes                                                                |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------- |
| **System prompt**  | ~10k–50k tokens                        | Bootstrap files (20k chars each), tool schemas, skills, safety, docs |
| **Tools**          | 20+ tools                              | exec, process, read, write, edit, memory, message, browser, etc.     |
| **Session**        | Full transcript                        | Persistent JSONL, history, compaction                                |
| **Tool loop**      | 2–10+ API calls per turn               | Model → tools → model → …                                            |
| **Model**          | Large (Claude/GPT-4)                   | $0.10–1.00/request                                                   |
| **Infrastructure** | Session lock, compaction, memory flush | Extra overhead                                                       |

---

## 3. Current Agent Model (Fit Check)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Agent model: Input → Purpose → Access → Output                      │
│  Each agent: single responsibility, explicit access, bounded       │
└─────────────────────────────────────────────────────────────────────┘

  RouterAgent (Agent 2)     →  decision only, no tools
  SimpleResponder (Agent 3a) →  completion only, no tools
  Pi (Agent 3b)             →  full orchestration, ALL tools

  Gap: Pi is monolithic. No "medium" agent with tools but lighter prompt.
```

---

## 4. Tradeoff Option A: Conditionally Heavy Pi

**Idea:** Make Pi lighter when the workload doesn’t need full power.

### Possible levers

| Lever                 | Description                                              | Fit with agent model     |
| --------------------- | -------------------------------------------------------- | ------------------------ |
| **Lighter bootstrap** | Inject fewer files (e.g. SOUL + TOOLS only for calendar) | ✅ Agent-specific access |
| **Tool subset**       | Pass only `tools.exec` for calendar agent                | ✅ Agent declares access |
| **Smaller model**     | Use 70B for calendar instead of Claude                   | ✅ Model tier per agent  |
| **No session**        | Stateless for single-turn calendar queries               | ⚠️ Breaks follow-ups     |
| **Prompt mode**       | Use `promptMode: "minimal"` (subagent style)             | ✅ Already exists        |

### Implementation sketch

- Add `agentCfg.bootstrapFiles?: string[]` – only inject listed files
- Add `agentCfg.toolProfile?: "minimal" | "exec-only" | "coding" | "full"` – restrict tools
- Add `agentCfg.modelOverride?: string` – e.g. `ollama/llama-3.2-70b` for calendar
- Reuse `promptMode: "minimal"` (AGENTS + TOOLS only, no SOUL/IDENTITY/USER/HEARTBEAT)

**Pros:** Stays in Pi, single code path, config-driven  
**Cons:** Pi still does session, tools, loop; only prompt and tool set are smaller

---

## 5. Tradeoff Option B: Medium-Strength Agent

**Idea:** New agent tier between SimpleResponder and full Pi.

### Medium agent shape

```
  MediumAgent (e.g. CalendarAgent)
  • Model: 🟡 70B local (~$0.01/request)
  • Tools: exec only (or exec + small allowlist)
  • Bootstrap: SOUL + TOOLS (minimal)
  • Session: none or single-turn (no transcript)
  • Loop: 1–2 API calls max (user → model → exec → model → reply)
```

### Implementation

- Extend `Agent` base class (like SimpleResponder)
- `execute()`: `completeSimple` + tool loop, or a thin wrapper around a “light Pi” loop
- Tools: `createExecTool` only, with `safeBins: ["gog"]`
- No `SessionManager`, no transcript, no compaction
- Router: `decision === "calendar"` → `CalendarAgent.execute()` instead of `runPreparedReply`

### Pros

- Fits agent model: purpose, access, output
- Clear boundaries: exec-only, no session
- Cheaper than full Pi
- Testable in isolation

### Cons

- New agent type and execution path
- No follow-ups unless you add session later
- Need to implement a minimal tool loop (or reuse `completeSimple` with a single tool call)

---

## 6. Comparison

| Dimension       | Option A: Conditionally Heavy Pi | Option B: Medium Agent |
| --------------- | -------------------------------- | ---------------------- |
| **Code path**   | Same Pi path, config-driven      | New agent path         |
| **Agent model** | Pi as agent 3b with config       | New agent class        |
| **Session**     | Full transcript                  | None or minimal        |
| **Follow-ups**  | Yes                              | No (unless extended)   |
| **Tools**       | Subset via config                | exec-only              |
| **Model**       | Configurable                     | 70B default            |
| **Cost**        | Lower than full Pi               | ~$0.01                 |
| **Complexity**  | Low (config)                     | Medium (new agent)     |

---

## 7. Recommendation

**Hybrid:**

1. **Short term (Option A):** Add `agentCfg.bootstrapFiles`, `agentCfg.toolProfile`, `agentCfg.modelOverride` for the calendar agent. Keeps Pi path, reduces prompt and tools.
2. **Medium term (Option B):** If calendar needs more isolation or you want to avoid Pi’s session/compaction overhead, add a `CalendarAgent` that extends `Agent` and implements a minimal exec-only tool loop.

**Calendar agent specifics:**

- Needs: exec (gog), SOUL, TOOLS
- Does not need: full bootstrap, 20+ tools, session history, compaction
- Option A gets you most of the benefit with config changes.
- Option B gives a cleaner separation and a template for other medium agents (e.g. email, search).
