---
summary: "Reply pipeline lifecycle: input → dispatch → phases → output"
read_when:
  - Navigating or refactoring the reply pipeline
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
   - **Routing** — Phase 1 classifies stay vs escalate; request router may override provider/model for "stay" and returns tier ("simple" or "complex"). See [Tiered model routing](/reference/tiered-model-routing).
   - **Run** — Execute agent based on tier:
     - **Simple tier** — Fast path: no session, minimal prompt, no tools (`runSimpleTierFastPath`)
     - **Complex tier** — Full agent: build full prompt, create session, load tools, stream (`runEmbeddedAttempt`)
4. **Output** — The reply dispatcher sends the reply back to the channel (typing, deliver, route-reply).

## Code layout (lifecycle-oriented)

- **Pipeline entry** — `gateway/agent/pipeline/dispatch.ts` — Main entry: `dispatchInboundMessage`, `dispatchReplyFromConfig`. Use this for "run the reply pipeline."
- **Reply building** — `gateway/agent/pipeline/reply/reply-building/`
  - `get-reply.ts` — Main resolver: `getReplyFromConfig`, calls routing, builds reply
  - `get-reply-run.ts` — Executes prepared reply: `runPreparedReply`
  - `dispatch-from-config.ts` — Dispatch wrapper: `dispatchReplyFromConfig`
- **Shared** — `gateway/agent/pipeline/` — Shared types and helpers: `templating.ts`, `types.ts`, etc.
- **Agent runner** — `gateway/agent/pipeline/reply/agent-runner/`
  - **core** — Main runner: `agent-runner.ts` (`runReplyAgent`, `runAgentTurnWithFallback`)
  - **phases/routing** — Phase 1 (stay/escalate): `phase-1.ts`
  - **routing** — Request router: `request-router.ts`
- **Skills & Commands** — `gateway/agent/skills/` — Skill and command registry, skill loading
- **Runtime** — `gateway/runtime/pi-embedded-runner/` — Agent execution:
  - `run.ts` — Entry: `runEmbeddedPiAgent`
  - `run/attempt.ts` — Tier branching: `runEmbeddedAttempt`, `runSimpleTierFastPath`
  - `system-prompt.ts` — System prompt building for complex tier
- **Input types** — One folder per channel; each turns inbound events into `MsgContext` and calls dispatch:
  - `gateway/telegram/` — Telegram bot
  - `gateway/discord/` — Discord bot
  - `gateway/signal/` — Signal
  - `gateway/line/` — LINE
  - `gateway/web/` — WhatsApp Web
  - `gateway/imessage/` — iMessage / Blue Bubbles
- **Routing (session/agent)** — `gateway/routing/` — Session keys, resolve-route, bindings. Used by channels and pipeline to resolve agent/session. Separate from "phase" routing above.
- **System prompts** — `gateway/agent/agents/classifier/prompt.ts` — Classifier prompt
- **UI** — `ui/` (repo root) — Control UI, routing tab, gateway UI. All app UI lives in this folder; gateway serves it.

## File map (current)

| Area           | Paths                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry          | `gateway/agent/pipeline/dispatch.ts`, `gateway/agent/pipeline/reply/dispatch-from-config.ts`                                                            |
| Reply building | `gateway/agent/pipeline/reply/reply-building/get-reply.ts`, `gateway/agent/pipeline/reply/reply-building/get-reply-run.ts`                              |
| Shared         | `gateway/agent/pipeline/templating.ts`, `gateway/agent/pipeline/types.ts`                                                                               |
| Routing        | `gateway/agent/pipeline/reply/agent-runner/phases/routing/phase-1.ts`, `gateway/agent/pipeline/reply/agent-runner/routing/request-router.ts`            |
| Agent runner   | `gateway/agent/pipeline/reply/agent-runner/core/agent-runner.ts`                                                                                        |
| Runtime        | `gateway/runtime/pi-embedded-runner/run.ts`, `gateway/runtime/pi-embedded-runner/run/attempt.ts`, `gateway/runtime/pi-embedded-runner/system-prompt.ts` |
| Skills         | `gateway/agent/skills/`                                                                                                                                 |
| Input          | `gateway/telegram/`, `gateway/discord/`, `gateway/signal/`, `gateway/line/`, `gateway/web/`, `gateway/imessage/`                                        |
| Session        | `gateway/routing/session-key.ts`, `gateway/routing/resolve-route.ts`, `gateway/routing/bindings.ts`                                                     |
