# Model-Loop Telemetry Design

## Goal

Build telemetry around a strict execution hierarchy:

1. `user_input`
2. `agent_loop`
3. `tool_loop`
4. `model_call`

This becomes the canonical source for counters, run diagnostics, and future cost/quality analytics.

## Scope

- Track local + cloud model usage consistently.
- Emit telemetry in real-time via `agent.event`.
- Persist telemetry to JSONL for later analysis.
- Ensure all test metrics can be computed from telemetry events (no fragile log parsing).

## Canonical Hierarchy

### 1) user_input

- Represents one inbound user message.
- Can contain multiple `agent_loop` items (handoff/chained execution).
- Suggested id: `userInputId` (UUID), attached to run context.

### 2) agent_loop

- Represents the lifecycle of a specialized agent holding routing state (router hold / mutex).
- May span multiple turns while follow-up is active.
- Contains one or more `tool_loop` items.

### 3) tool_loop

- Represents one prompt-execution cycle.
- Always exists, even with no tool use.
- Minimum cardinality: one `model_call`.
- Retries/fallbacks remain within this same `tool_loop`.

### 4) model_call

- Represents one model invocation attempt.
- Includes usage and attempt metadata.

## Event Stream

Emit all new events on `stream: "telemetry"` with typed `data.kind`.

### user_input

- `telemetry.user_input.start`
- `telemetry.user_input.end`

Fields:

- `userInputId`
- `runId`
- `sessionKey`
- `startedAt` / `endedAt`
- `durationMs`
- `agentLoopCount`
- `status`

### agent_loop

- `telemetry.agent_loop.start`
- `telemetry.agent_loop.end`

Fields:

- `userInputId`
- `agentLoopId`
- `runId`
- `agentId`
- `sessionKey`
- `routerHoldKey`
- `startedAt` / `endedAt`
- `durationMs`
- `toolLoopCount`
- `modelCallCount`
- `usageTotals` (`input/output/cacheRead/cacheWrite/total`)
- `status`

### tool_loop

- `telemetry.tool_loop.start`
- `telemetry.tool_loop.end`

Fields:

- `userInputId`
- `agentLoopId`
- `toolLoopId`
- `runId`
- `agentId`
- `startedAt` / `endedAt`
- `durationMs`
- `modelCallCount`
- `toolCallCount`
- `usageTotals`
- `status`

### model_call

- `telemetry.model_call.start`
- `telemetry.model_call.end`

Fields:

- `userInputId`
- `agentLoopId`
- `toolLoopId`
- `modelCallId`
- `runId`
- `agentId`
- `provider`
- `model`
- `attemptIndex`
- `attemptType` (`primary|retry|fallback`)
- `startedAt` / `endedAt`
- `durationMs`
- `usage`
- `finishReason`
- `toolCallsRequested`
- `status`
- `error` (optional)

## Retry/Fallback Semantics

- Retries/fallbacks stay in the same `tool_loop`.
- Every retry/fallback emits a separate `model_call`.
- Mark with:
  - `attemptIndex`
  - `attemptType`
  - `status` (`error` for failed attempt, `ok` for successful attempt)

## Persistence

Write append-only NDJSON:

- `~/.openclaw/logs/telemetry.jsonl`

Each line:

- `ts`
- `stream`
- `runId`
- `sessionKey`
- `data`

No relational DB required for v1.

## Logging (Verbose)

Mirror summaries in verbose mode:

- `[telemetry] model_call.end ...`
- `[telemetry] tool_loop.end ...`
- `[telemetry] agent_loop.end ...`
- `[telemetry] user_input.end ...`

These logs are diagnostic mirrors only; telemetry event stream remains source of truth.

## UI/Test Usage

Compute all counters from telemetry:

- model invocations (local/cloud)
- input/output tokens (local/cloud)
- loop counts
- per-level latency

No regex parsing of CLI output for token/call metrics.

## Acceptance Criteria

1. Cloud calls produce non-zero cloud invocation/token metrics when usage exists.
2. Invariants hold per run:
   - sum(`model_call` by `toolLoopId`) == `tool_loop.modelCallCount`
   - sum(`tool_loop` by `agentLoopId`) == `agent_loop.toolLoopCount`
   - sum(`agent_loop` by `userInputId`) == `user_input.agentLoopCount`
3. Retries/fallbacks are visible and countable via `attemptType`.
4. Metrics are identical in CLI and UI for same run ids.

## Implementation Phases

1. Emit telemetry events at all four levels.
2. Persist telemetry JSONL.
3. Switch test runner counters to telemetry-derived values.
4. Add invariant checks in tests.
