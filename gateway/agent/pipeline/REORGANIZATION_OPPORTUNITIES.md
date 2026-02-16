# Further Reorganization Opportunities

**Context**: After agent-runner was reorganized into core/, session/, routing/, queue/, this doc identifies additional refactoring opportunities.

---

## 1. Commands Registry Cluster (Pipeline Level)

**Current**: Flat at `gateway/agent/pipeline/`

```
command-auth.ts
command-detection.ts
commands-args.ts
commands-registry.ts
commands-registry.data.ts
commands-registry.test.ts
commands-registry.types.ts
command-control.test.ts
```

**Proposed**: `pipeline/commands-registry/` folder

```
commands-registry/
├── index.ts              # Re-export or main entry
├── commands-registry.ts
├── commands-registry.data.ts
├── commands-registry.types.ts
├── commands-registry.test.ts
├── command-auth.ts
├── command-control.test.ts
├── commands-args.ts
└── command-detection.ts   # Or keep at pipeline root if it's a top-level concern
```

**Importers** (would need path updates):

- reply/commands/_, reply/reply-building/_, reply/agent-runner/\*
- entrypoints (discord, telegram, slack)
- extensibility/plugins
- pipeline (templating, status, skill-commands, group-activation, send-policy)
- gateway/docs/slash-commands-doc.test.ts

**Blast radius**: ~15–20 files. All use `../../commands-registry` or `../commands-registry` – adding `commands-registry/` prefix is straightforward.

**Alternative**: Keep at pipeline root but group related tests. `command-control.test.ts` could move next to `command-auth` if we create a small `commands-registry/` subfolder for just the registry files (not command-auth, which is auth-specific).

---

## 2. Reply Directive E2E Tests (Pipeline Root → reply/e2e/)

**Current**: 12+ `reply.directive.directive-behavior.*.e2e.test.ts` at pipeline root

```
gateway/agent/pipeline/
├── reply.directive.directive-behavior.accepts-thinking-xhigh-codex-models.e2e.test.ts
├── reply.directive.directive-behavior.applies-inline-reasoning-mixed-messages-acks-immediately.e2e.test.ts
├── reply.directive.directive-behavior.defaults-think-low-reasoning-capable-models-no.e2e.test.ts
├── ... (9 more directive-behavior e2e tests)
├── reply.directive.parse.test.ts
└── ...
```

**Proposed**: Move to `reply/e2e/directive-behavior/` or `reply/e2e/directives/`

```
reply/e2e/
├── tiered-routing.e2e.test.ts          # Already here
├── directive-behavior/                 # NEW – all directive e2e tests
│   ├── accepts-thinking-xhigh-codex-models.e2e.test.ts
│   ├── applies-inline-reasoning-mixed-messages-acks-immediately.e2e.test.ts
│   └── ... (10 more)
└── triggers/                            # NEW – trigger-handling e2e tests
    ├── group-intro-prompts.e2e.test.ts
    ├── trigger-handling.allows-activation-from-allowfrom-groups.e2e.test.ts
    └── ... (15+ more)
```

**Vitest**: E2E config uses `gateway/**/*.e2e.test.ts` – moving files won't break discovery.

**Import updates**: These e2e tests likely import from pipeline/reply – paths would change from `../` to `../../` or similar. Need to verify each file.

---

## 3. Reply Unit Tests at Pipeline Root

**Current**: Scattered at pipeline root

```
reply.block-streaming.test.ts
reply.heartbeat-typing.test.ts
reply.media-note.test.ts
reply.queue.test.ts
reply.raw-body.test.ts
```

**Proposed**: Co-locate with implementation

- `reply.block-streaming.test.ts` → `reply/streaming/block-streaming.test.ts` (or similar)
- `reply.heartbeat-typing.test.ts` → `reply/streaming/typing.test.ts` or `reply/reply-building/` (depends on what it tests)
- `reply.media-note.test.ts` → `reply/` or `pipeline/` near `media-note.ts`
- `reply.queue.test.ts` → `reply/agent-runner/queue/` (queue tests already there)
- `reply.raw-body.test.ts` → next to `body` or `raw-body` implementation

**Blast radius**: Low – mostly moving tests, few external imports.

---

## 4. Heartbeat Files – Two Distinct Clusters

**Pipeline heartbeat** (reply/token handling):

- `pipeline/heartbeat.ts` – `stripHeartbeatToken`, `HEARTBEAT_TOKEN`, `resolveHeartbeatPrompt`
- `pipeline/heartbeat.test.ts`
- **Used by**: agent-runner, normalize-reply, pi-embedded-runner, infra heartbeat-runner, cron, web auto-reply

**Infra heartbeat** (scheduling/execution):

- `infra/heartbeat-runner.ts`
- `infra/heartbeat-events.ts`
- `infra/heartbeat-wake.ts`
- `infra/heartbeat-active-hours.ts`
- `infra/heartbeat-visibility.ts`
- - 8 test files

**Proposed**:

1. **Pipeline**: Keep `heartbeat.ts` at pipeline – it's a shared token/parsing utility for the reply pipeline. Optionally rename to `heartbeat-tokens.ts` for clarity.
2. **Infra**: Create `infra/heartbeat/` folder:
   ```
   infra/heartbeat/
   ├── runner.ts
   ├── events.ts
   ├── wake.ts
   ├── active-hours.ts
   ├── visibility.ts
   └── *.test.ts
   ```
   **Blast radius**: ~15 files import from infra heartbeat – server, cron, entrypoints, etc.

---

## 5. Agent-Runner Heartbeat Tests

**Current**: 5 long-named tests in `agent-runner/core/`:

```
agent-runner.heartbeat-typing.runreplyagent-typing-heartbeat.resets-corrupted-gemini-sessions-deletes-transcripts.test.ts
agent-runner.heartbeat-typing.runreplyagent-typing-heartbeat.retries-after-compaction-failure-by-resetting-session.test.ts
...
```

**Proposed**: Move to `agent-runner/core/heartbeat-typing/` subfolder

```
core/
├── heartbeat-typing/                    # Heartbeat+typing integration tests
│   ├── resets-corrupted-gemini-sessions.test.ts
│   ├── retries-after-compaction-failure.test.ts
│   ├── signals-typing-block-replies.test.ts
│   ├── signals-typing-normal-runs.test.ts
│   └── still-replies-even-if-session-reset-fails.test.ts
├── agent-runner.ts
└── ...
```

**Benefit**: Shorter names, clearer grouping. Import updates only within core/.

---

## 6. Directives – Already Grouped, Could Tighten

**Current**: `reply/directives/` has 11 files, `reply/reply-building/` has get-reply-directives\*, reply-directives.ts, `reply/utilities/` has directives.ts, streaming-directives.ts, line-directives.ts.

**Observation**: "Directives" is spread across 3 folders:

- `directives/` – directive-handling.\* (parsing, application)
- `reply-building/` – get-reply-directives\*, reply-directives (reply-specific)
- `utilities/` – directives.ts (types?), streaming-directives, line-directives

**Options**:

1. **Leave as-is** – each folder has a clear role.
2. **Create `reply/directives/` umbrella** – move get-reply-directives\*, reply-directives from reply-building into directives/, and line-directives, streaming-directives from utilities. Would make directives/ the single place for "directive" logic.
3. **Document the split** – add a short note in README explaining: `directives/` = handling, `reply-building/` = reply integration, `utilities/` = shared types/parsing.

---

## 7. Recommended Order (by impact / risk)

| Phase | Change                                                                      | Blast radius | Risk   |
| ----- | --------------------------------------------------------------------------- | ------------ | ------ |
| 1     | Move reply.directive.\*.e2e.test.ts → reply/e2e/directive-behavior/         | Low          | Low    |
| 2     | Move reply.triggers.\*.e2e.test.ts → reply/e2e/triggers/                    | Low          | Low    |
| 3     | Move reply.\*.test.ts (block-streaming, heartbeat-typing, etc.) → co-locate | Low          | Low    |
| 4     | Group agent-runner heartbeat-typing tests → core/heartbeat-typing/          | Low          | Low    |
| 5     | Create pipeline/commands-registry/ folder                                   | Medium       | Medium |
| 6     | Create infra/heartbeat/ folder                                              | Medium       | Medium |
| 7     | Consolidate directives (optional)                                           | High         | Higher |

---

## 8. Import Graph Snippets

**commands-registry importers** (pipeline level):

- command-detection, command-control.test
- templating, status, skill-commands, group-activation, send-policy, commands-args
- reply/commands (commands-core, commands-context), reply/reply-building (get-reply-directives)
- reply/agent-runner (routing/abort, session/session)
- entrypoints (discord, telegram, slack)
- extensibility/plugins
- gateway/docs

**heartbeat.ts importers** (pipeline):

- reply/agent-runner (core, routing), reply/reply-building (normalize-reply)
- pi-embedded-runner, cli-runner, compact
- infra/heartbeat-runner, cron, web auto-reply

**infra heartbeat importers**:

- server, cron, entrypoints, runtime/bash-tools

---

## Summary

**Quick wins** (Phases 1–4): Move tests into logical folders. Minimal logic changes, mostly path updates.

**Medium effort** (Phases 5–6): Group commands-registry and infra heartbeat into folders. More import updates but clear boundaries.

**Optional** (Phase 7): Directives consolidation – higher risk, needs careful dependency analysis.
