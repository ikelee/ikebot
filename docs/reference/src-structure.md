---
summary: "Hierarchy and groupings of gateway/ folders"
read_when:
  - Navigating or refactoring the codebase
  - Onboarding to the project
title: "Source structure (gateway/)"
---

# Source structure (gateway/)

This doc groups all top-level folders under **gateway/** (the server and pipeline core; formerly `src/`) by purpose and hierarchy. See also [Reply pipeline lifecycle](/reference/reply-lifecycle) for the auto-reply flow.

---

## 1. Reply pipeline (core flow)

**Input → dispatch → phases → output.** Single place the “message in, reply out” flow lives.

| Folder       | Purpose                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pipeline** | Reply pipeline: runner, shared helpers, phases (directives, routing, run), skills/commands. Entry: `runner.ts`, `dispatch.ts`, `reply/get-reply.ts`.                                    |
| **agents**   | Agent runtime: system prompt, Pi embedded runner (model selection in **models/**), tools, auth, workspace, sandbox. Used by the “run” phase.                                            |
| **models**   | Remote model interfacing: providers, model-selection, model-auth, models-config. Used by agents and pipeline.                                                                           |
| **routing**  | Session/agent routing (not phase routing): session keys, `resolveAgentRoute`, channel–account bindings. Used by channels and pipeline to resolve which agent/session handles a message. |

---

## 2. Channels (input types)

**One folder per messaging channel.** Each turns inbound events into `MsgContext` and calls into the reply pipeline (dispatch / getReplyFromConfig).

| Folder       | Purpose                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| **telegram** | Telegram bot: monitor, handlers, message context, delivery, native commands.                                       |
| **discord**  | Discord bot: monitor, message handler, threading, native commands, delivery.                                       |
| **signal**   | Signal: event handler, monitor, delivery.                                                                          |
| **slack**    | Slack: monitor, message handler, slash commands, threading, delivery.                                              |
| **line**     | LINE: bot, monitor, delivery.                                                                                      |
| **web**      | WhatsApp Web: login, session, inbox monitor, auto-reply wiring, outbound, media.                                   |
| **imessage** | iMessage / Blue Bubbles: monitor provider, delivery.                                                               |
| **whatsapp** | WhatsApp helpers only: JID normalization, target parsing. Used by `web/` and `channels/plugins/outbound/whatsapp`. |

**channels** — Shared channel layer: plugin types, outbound/actions/status-issues per channel, session, reply-prefix, ack reactions, command gating, web channel wrapper. Not a single “channel app”; it’s the shared adapter and plugin surface used by the channel folders above.

---

## 3. Gateway and runtime

**Long-lived process that serves the UI, WebSocket, and RPC.** Runs the reply pipeline when chat/message requests come in.

| Folder      | Purpose                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **gateway** | WebSocket gateway: server, protocol, session utils, chat/usage/skills/agents RPC, hooks, cron, channel list. Serves the control UI and receives agent/chat traffic. Lives under **gateway/server/**. |
| **macos**   | macOS-specific gateway/daemon wiring (e.g. menubar app, gateway daemon). **gateway/macos/**.                                                                                                         |
| **daemon**  | Cross-platform daemon/service install (launchd, systemd, schtasks) and audit. **gateway/daemon/**.                                                                                                   |
| **tui**     | Terminal UI: interactive TUI, command handlers, session actions. Now under **ui/tui/** (not under gateway).                                                                                          |

---

## 4. CLI and entrypoints

**User-facing commands and program entry.** All live under **gateway/entry/**.

| Folder             | Purpose                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **entry/cli**      | CLI wiring: program builder, subcommand registration (gateway, cron, update, etc.), deps, prompts, ports, route. **gateway/entry/cli/**.      |
| **entry/commands** | Implementation of high-level commands (agent, channels, health, onboard, status, sandbox, etc.) used by the CLI. **gateway/entry/commands/**. |
| **entry/wizard**   | Onboarding / first-run setup. **gateway/entry/wizard/**.                                                                                      |
| **entry/acp**      | Agent Control Protocol (IDE integration). **gateway/entry/acp/**.                                                                             |
| **entry.ts**       | Main CLI entry (invoked by `openclaw.mjs`): env, profile, then `run-main` → program. **gateway/entry.ts**.                                    |
| **index.ts**       | Legacy/bundled entry: exports and program run used by some builds. **gateway/index.ts**.                                                      |

---

## 5. Config, state, and infra

**Configuration, persistence, and cross-cutting infra.**

| Folder       | Purpose                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **config**   | Config load/save, types, schema, sessions store/paths, agent-dirs, group policy, channel capabilities, markdown tables.                                                                    |
| **infra**    | Ports, binaries, dotenv, env normalization, errors, path-env, runtime guard, unhandled rejections, heartbeat runner, outbound delivery, state migrations, exec approvals, channel summary. |
| **sessions** | Send policy and session-related behavior used by the pipeline and gateway.                                                                                                                 |
| **pairing**  | Pairing/allowlist state and helpers.                                                                                                                                                       |
| **memory**   | Memory/search backend and CLI used by agents and gateway.                                                                                                                                  |

---

## 6. Understanding and media

**Link/media understanding and TTS.**

| Folder                  | Purpose                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| **link-understanding**  | Link unfurling / understanding pipeline.                                                         |
| **media-understanding** | Media (image/audio) understanding: providers (Anthropic, Google, Deepgram, etc.), runner, apply. |
| **tts**                 | Text-to-speech integration.                                                                      |
| **media**               | Shared media utilities (if any) used across understanding and channels.                          |
| **markdown**            | Markdown parsing/formatting shared by config and UI.                                             |

---

## 7. Extensibility (plugins, hooks, SDK)

**Plugin system and SDK for channel and skill extensions.** All live under **gateway/extensibility/**.

| Folder                       | Purpose                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| **extensibility/plugins**    | Plugin runtime: load plugins, expose dispatch/config/channel helpers to plugins, commands.      |
| **extensibility/plugin-sdk** | Public plugin SDK: re-exports channel types, adapters, and APIs that extensions use.            |
| **extensibility/hooks**      | Hook system: bundled hooks (boot-md, session-memory, command-logger), event types, handler API. |

---

## 8. Integrations and tooling

**External integrations and dev tooling.**

| Folder               | Purpose                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **acp**              | Agent Control Protocol: IDE integration, gateway-backed ACP server, client, session store, translator. |
| **cron**             | Cron/scheduled jobs: service, store, jobs, isolated agent run, normalize.                              |
| **wizard**           | Onboarding wizard: session, prompts, completion, gateway config, finalize.                             |
| **security**         | Security/audit helpers (fix, audit-extra).                                                             |
| **docs**             | CLI docs generator (e.g. slash commands doc).                                                          |
| **models/providers** | LLM provider implementations (OpenAI, Anthropic, GitHub Copilot, etc.); see **gateway/models/**.       |

---

## 9. Host and UI runtimes

**Browser/Node host and in-app UI.**

| Folder          | Purpose                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| **browser**     | Browser host (e.g. Playwright) and routes used for automation or in-browser flows. |
| **node-host**   | Node host for running agent/automation in Node.                                    |
| **canvas-host** | Canvas/A2UI host and bundle for rich in-app UI.                                    |

---

## 10. Shared and cross-cutting

**Types, utils, logging, and process helpers used across many of the above.**

| Folder       | Purpose                                                            |
| ------------ | ------------------------------------------------------------------ |
| **utils**    | Shared utilities: E164, JID, message channel, etc.                 |
| **shared**   | Additional shared helpers used in multiple domains.                |
| **types**    | Shared TypeScript types (if not colocated with config/plugin-sdk). |
| **logging**  | Logging setup, capture, and formatters.                            |
| **terminal** | Terminal UI helpers: table, palette, progress.                     |
| **process**  | Process helpers: exec, child-process bridge.                       |
| **compat**   | Compatibility shims (e.g. Node/API compat).                        |

---

## 11. Test and scripts

**Test helpers and build/script utilities.**

| Folder           | Purpose                                                                         |
| ---------------- | ------------------------------------------------------------------------------- |
| **test-helpers** | Shared test helpers and mocks used by Vitest tests.                             |
| **test-utils**   | Additional test utilities.                                                      |
| **scripts**      | Scripts that live under src (if any); most scripts are in repo root `scripts/`. |

---

## Quick hierarchy (grouped)

```
Reply pipeline      pipeline, agents, routing
Channels            telegram, discord, signal, slack, line, web, imessage, whatsapp, channels
Gateway/runtime     gateway, macos, daemon, tui
CLI                 cli, commands
Config & infra      config, infra, sessions, pairing, memory
Understanding       link-understanding, media-understanding, tts, media, markdown
Extensibility       extensibility/plugins, extensibility/plugin-sdk, extensibility/hooks
Integrations        acp, cron, wizard, security, docs, providers
Hosts & UI          browser, node-host, canvas-host
Shared              utils, shared, types, logging, terminal, process, compat
Test                test-helpers, test-utils, scripts
```

---

## Where things live (quick lookup)

- **“Where is the reply pipeline?”** → **gateway/pipeline/** (runner, phases), **gateway/agents/** (model, prompt, run).
- **“Where is Phase 1 / request router?”** → **gateway/pipeline/reply/phases/routing/**, **gateway/pipeline/reply/request-router.ts**.
- **“Where do Telegram/Discord/etc. live?”** → **gateway/telegram/**, **gateway/discord/**, etc.; shared layer in **gateway/channels/**.
- **“Where is session key / resolve route?”** → **gateway/routing/** (session-key, resolve-route, bindings).
- **“Where is the gateway server?”** → **gateway/server/**.
- **“Where is the CLI built?”** → **gateway/entry/cli/**, **gateway/entry/commands/**, **gateway/entry.ts**.
- **“Where are plugins loaded?”** → **gateway/extensibility/plugins/runtime/**; public API in **gateway/extensibility/plugin-sdk/**.
- **“Where is config loaded?”** → **gateway/infra/config/**.
- **“Where is the control UI?”** → **ui/web/** (gateway serves it); TUI is **ui/tui/**.
