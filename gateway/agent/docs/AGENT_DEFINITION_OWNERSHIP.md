# Agent Definition Ownership

Where agent definitions live and why.

## Summary

| Concern                            | Owner  | Location                                     |
| ---------------------------------- | ------ | -------------------------------------------- |
| Which agents exist                 | Config | `openclaw.json` → `agents.list`              |
| User overrides (skills, tools, pi) | Config | `agents.list[].skills`, `.tools`, `.pi`      |
| Built-in pi defaults               | Code   | `agent/agents/*/agent.ts` → `pi-registry.ts` |
| Routing & run logic                | Code   | `agent/agents/*/run.ts`, `run.ts`            |

## Config (openclaw.json)

`agents.list` is the source of truth for **which agents exist** and **user overrides**:

- `id` – agent identifier (required)
- `default` – default agent for new sessions
- `skills` – skill allowlist (e.g. `["gog"]` for calendar)
- `tools` – tool config (e.g. exec allowlist for gog)
- `pi` – optional override for pi config (bootstrap, prompt mode, tools)

When `agents.list` is set, `applyBuiltInAgents` ensures `main`, `calendar`, `reminders`, `mail`, `workouts`, `finance`, and `multi` exist if missing. Users can add/remove agents and override any of the above.

## Code (agent/agents/\*)

Code defines **built-in behavior** that users typically don't need to configure:

1. **pi-registry.ts** – maps `agentId` → default `AgentPiConfig` (from agent modules)
2. **calendar/agent.ts** – `CALENDAR_PI_CONFIG` (exec-only preset)
3. **calendar/run.ts** – `runCalendarReply` (invoked when router returns "calendar")
4. **run.ts** – router → simple/calendar/complex dispatch

`resolvePiConfig(cfg, agentId)` uses the registry as base, then applies `agents.list[].pi` overrides from config.

## Why Not Put Everything in Config?

- **Pi config** (bootstrap files, prompt mode, tools allow) is derived from agent type. Calendar needs exec-only; main needs full. Putting `pi: { preset: "exec-only" }` in every user's config would be redundant.
- **Routing** (classifier → calendar vs complex) is implementation detail. Users enable calendar by having it in `agents.list`; they don't configure the router.
- **Single source of truth**: Config = "what I want"; Code = "how it works". Config overrides code when both exist.

## Adding a New Built-in Agent

1. Add `{ id: "myagent", ... }` to `applyBuiltInAgents` in `gateway/infra/config/defaults.ts` (so it appears in agents.list when list exists).
2. Create `agent/agents/myagent/agent.ts` with `MYAGENT_PI_CONFIG` and register in `pi-registry.ts`.
3. Create `agent/agents/myagent/run.ts` and wire routing in `run.ts`.
