# Agent-Level Pi Allowlist – Draft

## 1. Do Pi Phases Have Clear Input/Output?

**No.** Today `runEmbeddedAttempt` is a single monolithic function. Phases don't have explicit contracts:

| Phase | Input (implicit)                              | Output (implicit)                                 | Shared state           |
| ----- | --------------------------------------------- | ------------------------------------------------- | ---------------------- |
| 1     | `params`, `effectiveWorkspace`                | `skillsPrompt`, `contextFiles`, `restoreSkillEnv` | Mutates workspace, cwd |
| 2     | `params`, `effectiveWorkspace`, `sandbox`     | `tools`                                           | Tools list             |
| 3     | `tools`, `contextFiles`, `skillsPrompt`, etc. | `appendPrompt`, `systemPromptText`                | System prompt string   |
| 4     | `params.sessionFile`                          | `sessionLock`, `sessionManager`                   | Session handle         |
| 5     | `tools`, `sessionManager`, `systemPromptText` | `session` (Pi agent)                              | Active session         |
| 6     | `sessionManager`, `session`                   | (mutates session history)                         | Transcript             |
| 7–8   | `session`                                     | Subscription handle                               | Streaming              |
| 9     | `session`, `effectivePrompt`                  | (streaming)                                       | Response               |
| 10–11 | `session`, subscription                       | `EmbeddedRunAttemptResult`                        | Final output           |

**Implication:** To make phases configurable per agent, we'd need to either:

- **A)** Refactor into phase functions with typed I/O (bigger change)
- **B)** Pass an agent-level config and branch inside the existing flow (smaller change)

Draft below assumes **B** – config-driven branching, no phase refactor.

---

## 2. Draft: Agent Pi Allowlist Schema

Extend `agents.list[]` with a `pi` block that controls what the Pi runner does for this agent.

```typescript
// In agents.list[] (config) or AgentConfig
pi?: {
  /** Preset: "full" (default) | "minimal" | "exec-only" | "messaging-only"
   *  Overrides individual settings when set. */
  preset?: "full" | "minimal" | "exec-only" | "messaging-only";

  /** Which bootstrap files to inject. Omit = all. Empty = none. */
  bootstrapFiles?: ("AGENTS" | "SOUL" | "TOOLS" | "IDENTITY" | "USER" | "HEARTBEAT" | "MEMORY")[];

  /** System prompt mode: "full" | "minimal" | "none" */
  promptMode?: "full" | "minimal" | "none";

  /** Use session (transcript, history, compaction). False = stateless, no follow-ups. */
  session?: boolean;

  /** Tool profile or explicit allowlist. Overrides agents.list[].tools when in pi context. */
  tools?: {
    profile?: "minimal" | "coding" | "messaging" | "full";
    allow?: string[];  // e.g. ["exec"] or ["exec", "memory_search"]
    deny?: string[];
  };

  /** Include skills in prompt. False = empty skills section. */
  skills?: boolean;

  /** Max bootstrap chars per file (overrides agents.defaults.bootstrapMaxChars for this agent). */
  bootstrapMaxChars?: number;
};
```

---

## 3. Preset Definitions

| Preset             | bootstrapFiles | promptMode | session | tools                                                | skills |
| ------------------ | -------------- | ---------- | ------- | ---------------------------------------------------- | ------ |
| **full**           | all            | full       | true    | profile from agents.list                             | true   |
| **minimal**        | AGENTS, TOOLS  | minimal    | true    | profile from agents.list                             | false  |
| **exec-only**      | SOUL, TOOLS    | minimal    | true    | allow: ["exec"]                                      | false  |
| **messaging-only** | SOUL, TOOLS    | minimal    | true    | allow: ["message", "sessions_list", "sessions_send"] | false  |

---

## 4. Example Configs

### Calendar agent (exec-only, lighter)

```json
{
  "agents": {
    "list": [
      { "id": "main", "default": true },
      {
        "id": "calendar",
        "skills": ["gog"],
        "tools": {
          "exec": {
            "security": "allowlist",
            "safeBins": ["gog"]
          }
        },
        "pi": {
          "preset": "exec-only",
          "bootstrapFiles": ["SOUL", "TOOLS"],
          "promptMode": "minimal",
          "session": true,
          "tools": { "allow": ["exec"] },
          "skills": false
        }
      }
    ]
  }
}
```

### Mail manager (full – no overrides)

```json
{
  "agents": {
    "list": [
      {
        "id": "mail",
        "skills": ["gog"],
        "tools": {
          "exec": { "safeBins": ["gog", "node"] },
          "profile": "full"
        }
      }
    ]
  }
}
```

Omit `pi` → full Pi path (current behavior).

### Stateless calendar (no follow-ups)

```json
{
  "id": "calendar",
  "pi": {
    "preset": "exec-only",
    "session": false,
    "bootstrapFiles": ["SOUL", "TOOLS"]
  }
}
```

---

## 5. Resolution Logic (Pseudocode)

```typescript
function resolvePiConfig(agentId: string, cfg: OpenClawConfig): ResolvedPiConfig {
  const entry = resolveAgentConfig(cfg, agentId);
  const pi = entry?.pi;
  const preset = pi?.preset ?? "full";

  const presetDefaults = PRESET_DEFAULTS[preset];
  return {
    bootstrapFiles: pi?.bootstrapFiles ?? presetDefaults.bootstrapFiles,
    promptMode: pi?.promptMode ?? presetDefaults.promptMode,
    session: pi?.session ?? presetDefaults.session,
    tools: pi?.tools ?? presetDefaults.tools,
    skills: pi?.skills ?? presetDefaults.skills,
    bootstrapMaxChars: pi?.bootstrapMaxChars ?? cfg.agents?.defaults?.bootstrapMaxChars,
  };
}
```

---

## 6. Where to Apply in attempt.ts

| Phase           | Config key                      | Code change                                                                                                                          |
| --------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1 (steps 3–5)   | `skills: false`                 | Skip or empty `resolveSkillsPromptForRun`                                                                                            |
| 1 (step 6)      | `bootstrapFiles`                | Filter `contextFiles` before passing to `buildEmbeddedSystemPrompt`                                                                  |
| 2 (step 7)      | `tools.allow` / `tools.profile` | Pass allowlist to `createOpenClawCodingTools` or filter after                                                                        |
| 3 (steps 11–14) | `promptMode`, `bootstrapFiles`  | Pass to `buildEmbeddedSystemPrompt`                                                                                                  |
| 4–6             | `session: false`                | **Harder** – would need a stateless path (no SessionManager, no transcript). Could mean "single-turn only" with a throwaway session. |

**Note:** `session: false` is a bigger change – the Pi library expects a session. Options:

- Keep session but don't persist (ephemeral session file)
- Or add a separate "stateless Pi" code path that uses `completeSimple` + one tool-call round (closer to a medium agent)

---

## 7. Summary

| Question               | Answer                                                 |
| ---------------------- | ------------------------------------------------------ |
| Clear phase I/O?       | No – monolithic, shared state                          |
| Agent-level allowlist? | Draft above – `pi` block on `agents.list[]`            |
| Presets?               | `full` \| `minimal` \| `exec-only` \| `messaging-only` |
| Backward compatible?   | Yes – omit `pi` → full behavior                        |

**Next step:** Implement `resolvePiConfig` and wire `bootstrapFiles`, `promptMode`, `tools` into `runEmbeddedAttempt` for `agentId`. Defer `session: false` until we have a clear stateless design.
