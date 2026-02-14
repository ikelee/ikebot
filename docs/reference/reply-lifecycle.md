---
summary: "Reply pipeline lifecycle: input → dispatch → phases → output"
read_when:
  - Navigating or refactoring the auto-reply pipeline
  - Adding new input types, phases, or skills
title: "Reply pipeline lifecycle"
---

# Reply pipeline lifecycle

This doc describes how input flows through the system until a reply goes out, and how the codebase is organized around that flow.

## Flow overview

1. **Input** — A message arrives on a channel (Telegram, Discord, Signal, Line, WhatsApp Web, iMessage/Blue Bubbles, etc.). The channel monitor builds a `MsgContext` and calls into the reply pipeline.
2. **Dispatch** — Single entry: `dispatchInboundMessage` / `dispatchReplyFromConfig`. Finalizes context, skips dupes, runs hooks, then invokes the reply resolver.
3. **Phases** — The reply resolver (`getReplyFromConfig`) runs in stages:
   - **Directives** — Resolve inline directives, model selection, commands allowlist, group/mention rules, think/verbose levels.
   - **Routing** — Phase 1 classifies stay vs escalate; request router may override provider/model for “stay”. See [Tiered model routing](/reference/tiered-model-routing).
   - **Run** — Build prompt, run agent (embedded Pi or CLI), handle followups, queue if needed.
4. **Output** — The reply dispatcher sends the reply back to the channel (typing, deliver, route-reply).

## Code layout (lifecycle-oriented)

- **Runner (top)** — `src/auto-reply/runner.ts` — Main entry: `getReplyFromConfig`, `dispatchInboundMessage`, `dispatchReplyFromConfig`. Use this for “run the reply pipeline.”
- **Shared (top)** — `src/auto-reply/shared/` — Shared types and helpers used across the pipeline: context/templating, types, tokens, thinking, send-policy, etc.
- **Phases** — `src/auto-reply/reply/phases/`
  - **directives** — Resolve what model, commands, and options apply: `get-reply-directives*`, `directive-handling*`, `model-selection.ts`, `mentions.ts`, `groups.ts`, etc.
  - **routing** — Phase 1 (stay/escalate) and request router: `phases/routing/` (phase-1.ts), `request-router.ts`.
  - **run** — Execute the agent and deliver: `get-reply-run.ts`, `agent-runner*`, `followup-runner.ts`, `queue/`, etc.
- **Skills** — `src/auto-reply/` — Skill and command registry: `commands-registry.ts`, `commands-registry.types.ts`, `skill-commands.ts`. (Logical group; may move to `skills/` later.)
- **Input types** — One folder per channel; each turns inbound events into `MsgContext` and calls dispatch:
  - `src/telegram/` — Telegram bot
  - `src/discord/` — Discord bot
  - `src/signal/` — Signal
  - `src/line/` — LINE
  - `src/web/` — WhatsApp Web (and `web/auto-reply/` for channel-specific reply wiring)
  - `src/imessage/` — iMessage / Blue Bubbles
- **Routing (session/agent)** — `src/routing/` — Session keys, resolve-route, bindings. Used by channels and pipeline to resolve agent/session. Separate from “phase” routing above.
- **Agents** — `src/agents/` — System prompt, model selection, Pi embedded runner, tools. Invoked from the “run” phase.
- **UI** — `ui/` (repo root) — Control UI, routing tab, gateway UI. All app UI lives in this folder; gateway serves it.

## File map (current)

| Area       | Paths                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Runner     | `auto-reply/runner.ts`, `auto-reply/dispatch.ts`, `reply/dispatch-from-config.ts`, `reply/get-reply.ts`                              |
| Shared     | `auto-reply/shared/` (re-exports), `templating.ts`, `types.ts`, `tokens.ts`, `thinking.ts`                                           |
| Directives | `reply/get-reply-directives*.ts`, `reply/directive-handling*.ts`, `reply/model-selection.ts`, `reply/mentions.ts`, `reply/groups.ts` |
| Routing    | `reply/phases/routing/` (phase-1), `reply/request-router.ts`                                                                         |
| Run        | `reply/get-reply-run.ts`, `reply/agent-runner*.ts`, `reply/followup-runner.ts`, `reply/queue/`                                       |
| Skills     | `commands-registry.ts`, `commands-registry.types.ts`, `skill-commands.ts`                                                            |
| Input      | `telegram/`, `discord/`, `signal/`, `line/`, `web/`, `imessage/`                                                                     |
| Session    | `routing/session-key.ts`, `routing/resolve-route.ts`, `routing/bindings.ts`                                                          |
