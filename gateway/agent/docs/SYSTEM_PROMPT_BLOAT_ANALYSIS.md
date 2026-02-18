# System Prompt Bloat Analysis – Calendar Agent

**Context:** User query "what do I have scheduled tomorrow?" produced a ~25,657 char system prompt. The calendar agent should use a much smaller prompt via `pi: { preset: "exec-only" }`. This doc breaks down the dump, maps sections to code, and proposes PI config changes.

**Cross-reference:** [PI_PHASES_CODE_MAP.md](./PI_PHASES_CODE_MAP.md), [AGENT_PI_ALLOWLIST_DRAFT.md](./AGENT_PI_ALLOWLIST_DRAFT.md)

---

## 1. Why Is the Prompt So Large?

The dump shows **full** mode (promptMode=full, all bootstrap files, all tools, all skills). That implies one of:

1. **Calendar agent not in config** – `runCalendarReply` falls back to `runComplexReply` when `resolveAgentConfig(cfg, "calendar")` is null. Complex uses main agent with full piConfig.
2. **Routing disabled** – Router never runs; flow goes straight to complex.
3. **Classifier returns "escalate"** – Query routed to main/complex instead of calendar.

**Fix:** Ensure `agents.list` includes the calendar agent with `pi: { preset: "exec-only" }` and routing is enabled.

---

## 2. Prompt Dump Breakdown

| Part | Section                         | Est. chars   | Source (Phase)                            | Needed for calendar? | PI config to remove              |
| ---- | ------------------------------- | ------------ | ----------------------------------------- | -------------------- | -------------------------------- |
| 1    | Conversational replies          | ~600         | `system-prompt.ts` (Phase 3)              | Yes (trimmed)        | promptMode=minimal keeps core    |
| 1    | Tooling (full list)             | ~1,200       | `createOpenClawCodingTools` (Phase 2)     | No – need exec only  | toolsAllow: ["exec"]             |
| 1    | Tool Call Style                 | ~300         | `system-prompt.ts`                        | Yes                  | —                                |
| 1    | Safety                          | ~400         | `system-prompt.ts`                        | Yes                  | —                                |
| 2    | OpenClaw CLI Quick Reference    | ~400         | `system-prompt.ts`                        | No                   | promptMode=minimal skips         |
| 2–4  | **Skills (mandatory)**          | ~1,500       | `resolveSkillsPromptForRun` (Phase 1)     | No                   | skills: false                    |
| 4    | OpenClaw Self-Update            | ~400         | `system-prompt.ts`                        | No                   | promptMode=minimal skips         |
| 4    | Workspace                       | ~200         | `system-prompt.ts`                        | Yes                  | —                                |
| 4    | Documentation                   | ~400         | `buildDocsSection`                        | No                   | promptMode=minimal skips         |
| 4    | User Identity                   | ~100         | `buildUserIdentitySection`                | No                   | promptMode=minimal skips         |
| 4    | Current Date & Time             | ~50          | `buildTimeSection`                        | Yes                  | —                                |
| 4–5  | Workspace Files (injected)      | header only  | —                                         | —                    | —                                |
| 5    | Reply Tags                      | ~300         | `buildReplyTagsSection`                   | No                   | promptMode=minimal skips         |
| 5–6  | Messaging                       | ~800         | `buildMessagingSection`                   | No                   | promptMode=minimal skips         |
| 6    | Inbound Context (JSON)          | ~400         | extraSystemPrompt                         | Yes (small)          | —                                |
| 6    | Reasoning Format                | ~200         | reasoningHint                             | Yes                  | —                                |
| 6–13 | **Project Context (bootstrap)** | **~12,000+** | `resolveBootstrapContextForRun` (Phase 1) | Partial              | bootstrapFiles: ["SOUL","TOOLS"] |
| 13   | Silent Replies                  | ~400         | `system-prompt.ts`                        | No                   | promptMode=minimal skips         |
| 13   | Heartbeats                      | ~600         | `system-prompt.ts`                        | No                   | promptMode=minimal skips         |
| 13   | Runtime                         | ~200         | `buildSystemPromptParams`                 | Yes                  | —                                |

---

## 3. Bootstrap Files (Largest Bloat)

| File         | Est. chars | Needed for calendar?                        | Key                                  |
| ------------ | ---------- | ------------------------------------------- | ------------------------------------ |
| AGENTS.md    | ~3,500     | No – full session rules, memory, heartbeats | AGENTS                               |
| SOUL.md      | ~800       | Yes – persona/tone                          | SOUL                                 |
| TOOLS.md     | ~600       | Yes – gog notes, exec usage                 | TOOLS                                |
| IDENTITY.md  | ~400       | No                                          | IDENTITY                             |
| USER.md      | ~300       | No                                          | USER                                 |
| HEARTBEAT.md | ~400       | No                                          | HEARTBEAT                            |
| BOOTSTRAP.md | ~1,200     | No                                          | (not in key list; comes with AGENTS) |
| MEMORY.md    | —          | No (main session only)                      | MEMORY                               |

**exec-only preset:** `bootstrapFiles: ["SOUL", "TOOLS"]` → ~1,400 chars vs ~6,200+ for full set.

---

## 4. PI Phase → Code Map (from PI_PHASES_CODE_MAP.md)

| Phase | Step  | What                | Config key                     | Calendar optimization           |
| ----- | ----- | ------------------- | ------------------------------ | ------------------------------- |
| 1     | 3–5   | Load skills         | `skills: false`                | Empty skillsPrompt              |
| 1     | 6     | Resolve bootstrap   | `bootstrapFiles`               | Filter to SOUL, TOOLS           |
| 2     | 7     | Create tools        | `toolsAllow`                   | Filter to exec only             |
| 3     | 11–14 | Build system prompt | `promptMode`, `bootstrapFiles` | minimal + filtered contextFiles |

---

## 5. What promptMode=minimal Actually Removes

From `gateway/runtime/system-prompt.ts`:

- **Skills section** – `buildSkillsSection` returns `[]` when `isMinimal`
- **Memory section** – `buildMemorySection` returns `[]`
- **Docs section** – `buildDocsSection` returns `[]`
- **User Identity** – `buildUserIdentitySection` returns `[]`
- **Reply Tags** – `buildReplyTagsSection` returns `[]`
- **Messaging** – `buildMessagingSection` returns `[]`
- **Voice (TTS)** – `buildVoiceSection` returns `[]`
- **OpenClaw Self-Update** – skipped
- **Model Aliases** – skipped
- **Silent Replies** – skipped
- **Heartbeats** – skipped

**Still included in minimal:** Conversational replies, Tooling (filtered list), Tool Call Style, Safety, Workspace, Time, Reasoning Format, Project Context (filtered bootstrap), Runtime.

---

## 6. Proposed PI Config for Calendar

From `gateway/runtime/agent-scope.ts` – exec-only preset:

```typescript
"exec-only": {
  bootstrapFiles: ["SOUL", "TOOLS"],
  promptMode: "minimal",
  session: true,
  skills: false,
  toolsAllow: ["exec"],
}
```

**Example agents.list entry:**

```json
{
  "id": "calendar",
  "skills": ["gog"],
  "tools": {
    "exec": { "security": "allowlist", "safeBins": ["gog"] }
  },
  "pi": {
    "preset": "exec-only",
    "bootstrapFiles": ["SOUL", "TOOLS"],
    "promptMode": "minimal",
    "tools": { "allow": ["exec"] },
    "skills": false
  }
}
```

---

## 7. Estimated Prompt Size After Optimization

| Component                                                             | Full               | exec-only        |
| --------------------------------------------------------------------- | ------------------ | ---------------- |
| Core prompt (identity, tooling, safety, workspace, time, reasoning)   | ~3,500             | ~2,500           |
| Tool list                                                             | ~1,200 (20+ tools) | ~100 (exec only) |
| Skills                                                                | ~1,500             | 0                |
| Bootstrap (AGENTS, SOUL, TOOLS, IDENTITY, USER, HEARTBEAT, BOOTSTRAP) | ~6,200+            | ~1,400           |
| Messaging, Reply Tags, Docs, Self-Update, Silent, Heartbeats          | ~3,000             | 0                |
| **Total**                                                             | **~25,600**        | **~4,000–5,000** |

---

## 8. Updates to PI_PHASES_CODE_MAP.md

Add a row to **High-Impact Optimization Points**:

| Goal                         | Phase | Code               | Change                                                                                                                |
| ---------------------------- | ----- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Calendar agent in config** | —     | `runCalendarReply` | Ensure `agents.list` includes `{ id: "calendar", pi: { preset: "exec-only" } }` so flow does not fall back to complex |

---

## 9. Next Steps

1. **Verify config** – User should add calendar agent to `agents.list` with `pi: { preset: "exec-only" }`.
2. **Verify routing** – Classifier must return `"calendar"` for "what do I have scheduled tomorrow?".
3. **Tests added** – `gateway/agent/agents/calendar/calendar.test.ts`:
   - Routing: "what do I have on Friday, the 21st", "schedule a meeting with James tomorrow" → calendar agent.
   - piConfig: exec-only preset (SOUL+TOOLS, exec only, minimal prompt, no skills).
   - Fallback: when calendar not in config, falls back to complex agent.

**Future:** E2E test with mock Google user – mock `exec` (or `spawn`) to return fake `gog calendar events` JSON when command matches; verify agent summarizes events. Requires mocking at bash-tools or spawn level.
