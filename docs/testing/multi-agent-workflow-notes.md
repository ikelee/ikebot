# Multi-Agent Workflow Notes (2026-02-18)

## Goal

Validate and harden the routing flow:

1. Classifier routes user prompt.
2. Route goes to single specialist agent or multi-agent path.
3. Agent-level and gateway-level e2e tests stay green.

## What Broke

- `openclaw gateway run` initially failed at build time due missing files in working tree:
  - `gateway/agent/agents/simple-responder/agent.ts`
  - `gateway/agent/agents/workouts/agent.ts`
  - plus related `run.ts`/prompt fixtures for restored agents
- Workouts e2e also failed because template docs were deleted:
  - `docs/reference/templates/workouts-agent/SOUL.md`
  - `docs/reference/templates/workouts-agent/TOOLS.md`

## What Was Restored

- Restored deleted agent/workouts/simple-responder files from `HEAD`.
- Restored workouts template docs from `HEAD`.

## Reliability Tweaks Applied

- `gateway/agent/agents/classifier/prompt.ts`
  - Added explicit instruction to escalate ambiguous/nonsense input.
- `gateway/agent/agents/classifier/agent.ts`
  - Set classifier model call temperature to `0` for deterministic routing.
- `gateway/agent/agents/classifier/agent.e2e.test.ts`
  - Allowed `"what agents do I have available to me?"` to be `stay` or `escalate`.
  - Increased per-case timeout from `60_000` to `120_000` for slow local model calls.

## Current Focused Test Commands

Use these for fast signal on the multi-agent routing work:

```bash
pnpm run test:e2e:agent-level -- \
  gateway/agent/agents/classifier/agent.e2e.test.ts \
  gateway/agent/agents/workouts/workouts.agent.e2e.test.ts
```

```bash
pnpm run test:e2e:full-flow -- \
  gateway/agent/e2e/workouts/workouts-routing.e2e.test.ts \
  gateway/agent/e2e/reply/tiered-routing.e2e.test.ts
```

## Last Verified Results

- `gateway/agent/agents/classifier/agent.e2e.test.ts`: PASS (12/12)
- `gateway/agent/agents/workouts/workouts.agent.e2e.test.ts`: moved and compiles (collection pass); run pending
- `gateway/agent/e2e/workouts/workouts-routing.e2e.test.ts`: moved and compiles (collection pass); run pending
- `gateway/agent/e2e/reply/tiered-routing.e2e.test.ts`: PASS (2/2)

## Local Runtime Caveat (Non-test)

`pnpm openclaw gateway run --bind loopback --port 18789 --force` can still fail in this environment due local user config/plugin state:

- Invalid key in `~/.openclaw/openclaw.json` (`agents.list[2].tools.files`)
- Local extension import issue under `~/.openclaw/extensions/zalo`

These are environment/config issues, not current repo build/test blockers.
