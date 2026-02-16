# Agent-Runner Import Graph & Reorganization Strategy

**Purpose**: Identify hub vs leaf files, thematic boundaries, and name-based groupings to guide hierarchy with minimal import churn.

**Status**: ✅ **IMPLEMENTED** (Feb 2026) – Structure below is now in place. Tests co-located in folders.

---

## 1. External Entry Points (Who imports FROM agent-runner)

These are the **only files** that need import path updates when we move things. Updating these is acceptable (orchestrators).

| File                                                  | Imports from agent-runner                                 |
| ----------------------------------------------------- | --------------------------------------------------------- |
| **reply-building/get-reply.ts**                       | `runAgentFlow` (run.ts), `session-reset-model`, `session` |
| **reply-building/get-reply-run.ts**                   | `agent-runner`, `queue`, `route-reply`, `session-updates` |
| **reply-building/dispatch-from-config.ts**            | `abort`, `route-reply`                                    |
| **reply-building/get-reply-inline-actions.ts**        | `abort`                                                   |
| **commands/commands-core.ts**                         | `route-reply`                                             |
| **commands/commands-session.ts**                      | `abort`, `queue`                                          |
| **commands/commands-compact.ts**                      | `session-updates`                                         |
| **commands/commands-subagents.ts**                    | `abort`, `queue`                                          |
| **commands/commands-status.ts**                       | `queue`                                                   |
| **directives/directive-handling.parse.ts**            | `queue`                                                   |
| **directives/directive-handling.queue-validation.ts** | `queue`                                                   |
| **utilities/body.ts**                                 | `abort`                                                   |
| **utilities/directives.ts**                           | `exec/directive`                                          |

**Total: ~13 import sites across 10 files.** These are the only places we touch when moving agent-runner internals.

---

## 2. Internal Import Graph (agent-runner only)

### Hub Files (many internal importers – keep at shallow level or as entry points)

| File                          | Imported by (internal)                                                           | Role                                    |
| ----------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| **agent-runner.ts**           | 18+ test files, get-reply-run                                                    | **Main orchestrator** – top-level entry |
| **queue.ts**                  | agent-runner, followup-runner, abort, agent-runner-\*, 18+ tests                 | **Barrel** – re-exports queue/\*        |
| **queue/** (folder)           | queue.ts barrel, internal only                                                   | Already well-grouped                    |
| **agent-runner-utils.ts**     | agent-runner-execution, agent-runner-memory, agent-runner-payloads, agent-runner | **Shared core utils**                   |
| **session-updates.ts**        | agent-runner-memory, session-run-accounting, session-resets.test                 | Session state updates                   |
| **session-run-accounting.ts** | agent-runner, followup-runner                                                    | Usage tracking                          |
| **route-reply.ts**            | agent-runner, followup-runner, commands-core                                     | Reply routing                           |
| **abort.ts**                  | agent-runner (indirect), commands, reply-building                                | Abort handling                          |

### Leaf Files (few internal importers – safe to nest)

| File                       | Imported by (internal)          | Role                        |
| -------------------------- | ------------------------------- | --------------------------- |
| **session-reset-model.ts** | get-reply.ts (external only!)   | Model reset – **pure leaf** |
| **session-usage.ts**       | session-run-accounting only     | Usage calc – leaf           |
| **memory-flush.ts**        | agent-runner-memory only        | Memory flush – leaf         |
| **followup-runner.ts**     | agent-runner only               | Followup execution – leaf   |
| **exec.ts** + **exec/**    | utilities/directives (external) | Exec directive – leaf       |

### Mid-Level (imported by hub, import from leaves)

| File                          | Imported by              | Imports from                                             |
| ----------------------------- | ------------------------ | -------------------------------------------------------- |
| **agent-runner-execution.ts** | agent-runner             | queue, agent-runner-utils                                |
| **agent-runner-helpers.ts**   | agent-runner             | queue                                                    |
| **agent-runner-memory.ts**    | agent-runner             | queue, agent-runner-utils, memory-flush, session-updates |
| **agent-runner-payloads.ts**  | agent-runner             | agent-runner-utils                                       |
| **session.ts**                | get-reply, session tests | session-updates (indirect), many externals               |

---

## 3. Name-Based Clusters (Brain Clusters)

Files with similar names should live together. Current flat list is cognitively heavy.

### Cluster A: `agent-runner-*` (6 files)

- agent-runner.ts
- agent-runner-execution.ts
- agent-runner-helpers.ts
- agent-runner-memory.ts
- agent-runner-payloads.ts
- agent-runner-utils.ts

**Theme**: Core execution pipeline. agent-runner.ts orchestrates; the rest are helpers.

### Cluster B: `session*` (5 files)

- session.ts
- session-updates.ts
- session-run-accounting.ts
- session-usage.ts
- session-reset-model.ts

**Theme**: Session lifecycle – init, updates, usage, reset.

### Cluster C: `queue*` (already in queue/)

- queue.ts (barrel at root)
- queue/cleanup.ts, directive.ts, drain.ts, enqueue.ts, normalize.ts, settings.ts, state.ts, types.ts

**Theme**: Queue management. Already well-organized.

### Cluster D: Routing & control (3 files)

- route-reply.ts
- abort.ts
- followup-runner.ts
- memory-flush.ts

**Theme**: Request flow – classify, route, abort, followup, memory.

### Cluster E: Exec (already in exec/)

- exec.ts (barrel)
- exec/directive.ts

**Theme**: Execution directives. Already nested.

---

## 4. Implemented Hierarchy ✅

Strategy: **Group by name cluster**. Tests co-located in each folder.

```
agent-runner/
├── core/                        # agent-runner-* cluster + tests
│   ├── agent-runner.ts         # Main orchestrator – entry point
│   ├── agent-runner-execution.ts
│   ├── agent-runner-helpers.ts
│   ├── agent-runner-memory.ts
│   ├── agent-runner-payloads.ts
│   ├── agent-runner-utils.ts
│   ├── agent-runner-utils.test.ts
│   └── agent-runner.*.test.ts  (18 test files)
│
├── session/                     # session* cluster + tests
│   ├── session.ts
│   ├── session-updates.ts
│   ├── session-run-accounting.ts
│   ├── session-usage.ts
│   ├── session-reset-model.ts
│   ├── session.test.ts
│   ├── session-updates.incrementcompactioncount.test.ts
│   ├── session-resets.test.ts
│   └── session-usage.test.ts
│
├── routing/                     # request-router, route-reply, abort, followup, memory-flush + tests
│   ├── route-reply.ts
│   ├── abort.ts
│   ├── followup-runner.ts
│   ├── memory-flush.ts
│   ├── abort.test.ts
│   ├── followup-runner.test.ts
│   ├── memory-flush.test.ts
│   ├── reply-routing.test.ts
│   └── route-reply.test.ts
│
├── queue.ts                     # Barrel
├── queue/                       # Queue implementation + test
│   ├── cleanup.ts, directive.ts, drain.ts, enqueue.ts
│   ├── normalize.ts, settings.ts, state.ts, types.ts
│   └── queue.collect-routing.test.ts
│
├── exec.ts
├── exec/                        # Execution directives
├── IMPORT_GRAPH.md
└── README.md
```

### Import Change Count

| Move                                    | External updates                               | Internal updates                                       |
| --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| **core/** (agent-runner-\*)             | 1 (get-reply-run → agent-runner)               | 1 (agent-runner.ts imports 5 files)                    |
| **session/** (session\*)                | 4 (get-reply, get-reply-run, commands-compact) | ~6 (session-run-accounting, agent-runner-memory, etc.) |
| **routing/** (abort, route-reply, etc.) | 6 (commands, reply-building, directives)       | ~4 (agent-runner, followup-runner)                     |

**Total: ~10 external + ~11 internal = ~21 import updates.** All are single-path changes (add `core/`, `session/`, or `routing/` prefix).

---

## 5. Alternative: Flatter by Entry Point

If we want **zero internal import changes**, we could:

1. **Only move leaves** that are imported by external files only:
   - `session-reset-model.ts` → `session/` (only get-reply imports it)
   - Update get-reply.ts: `session-reset-model` → `session/session-reset-model`

2. **Keep hubs flat** – agent-runner.ts, queue.ts, session-updates.ts stay at root.

3. **Create folders for clusters** but use **barrel files** at root:
   - `session/index.ts` re-exports session\*.ts
   - External imports stay `../agent-runner/session` (barrel)
   - Internal imports use `./session/session-updates` etc.

This minimizes churn but adds barrel indirection.

---

## 6. Recommended Approach

**Phase 1 – Low risk (leaves only)**  
Move `session-reset-model.ts` → `session/`. Update 1 file: get-reply.ts.

**Phase 2 – Name clusters**  
Move `session*` → `session/`, `agent-runner-*` → `core/`, routing files → `routing/`.  
Use IDE "Move to" refactor so TypeScript updates all imports automatically.

**Phase 3 – Verify**  
Run `pnpm build` and `pnpm test:e2e gateway/agent/pipeline/reply/e2e`.

---

## 7. Dependency Diagram (Simplified)

```
                    get-reply.ts
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   runAgentFlow      session-reset   session
   (run.ts)              (leaf)      (hub)
         │                              │
         │                     session-updates
         │                              │
         │                              ▼
         │                     session-run-accounting
         │                              │
         │                              ▼
         │                     session-usage (leaf)

   get-reply-run.ts
         │
         ├──► agent-runner (hub)
         │         │
         │         ├──► agent-runner-execution
         │         ├──► agent-runner-helpers
         │         ├──► agent-runner-memory
         │         ├──► agent-runner-payloads
         │         ├──► agent-runner-utils
         │         ├──► followup-runner
         │         ├──► queue
         │         ├──► session-run-accounting
         │         └──► streaming/, reply-building/
         │
         ├──► queue
         ├──► route-reply
         └──► session-updates
```

---

## 8. Test File Note

Many tests have **stale imports** like `./agent-runner/session/session.js` (from a previous failed move). These should be fixed to `./session.js` when at root, or `./session/session.js` when session is in a folder. Run a project-wide fix after structure is finalized.
