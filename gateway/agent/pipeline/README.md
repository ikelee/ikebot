# Reply pipeline

Reply lifecycle: **input → dispatch → phases (directives, routing, run) → output**. See [Reply pipeline lifecycle](https://docs.openclaw.ai/reference/reply-lifecycle) for the full flow and file map.

## Layout

- **Runner** — `runner.ts` is the main entry: `getReplyFromConfig`, `dispatchInboundMessage`, `dispatchReplyFromConfig`. Channels and gateway call these.
- **Shared** — `shared/` re-exports common types and helpers (context, types, tokens, thinking) used across the pipeline.
- **Phases** — `reply/phases/`
  - **directives** — Resolve model, commands, mentions, groups, think/verbose (files under `reply/`; see lifecycle doc).
  - **routing** — Phase 1 (stay/escalate) and request router.
  - **run** — get-reply-run, agent-runner, followup-runner, queue.
- **Skills** — Commands and skill registry: `commands-registry.ts`, `skill-commands.ts` (at this level).

Input types (Telegram, Discord, Signal, Line, Web, iMessage) live under `src/<channel>/`. UI lives in `ui/` at repo root.
