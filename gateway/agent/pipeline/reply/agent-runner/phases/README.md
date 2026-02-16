# Reply pipeline phases

The reply pipeline runs in three logical phases. See [Reply pipeline lifecycle](https://docs.openclaw.ai/reference/reply-lifecycle).

- **directives** — Resolve model, commands, mentions, groups, think/verbose. Files: `get-reply-directives*.ts`, `directive-handling*.ts`, `model-selection.ts`, `mentions.ts`, `groups.ts`, etc. (live in parent `reply/`.)
- **routing** — Phase 1 (stay/escalate) and request router. This folder: `routing/phase-1.ts`, `routing/index.ts`. Plus `request-router.ts` in `reply/`.
- **run** — Execute agent and deliver. Files: `get-reply-run.ts`, `agent-runner*.ts`, `followup-runner.ts`, `queue/`, etc. (live in parent `reply/`.)
