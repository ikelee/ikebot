# Reply pipeline phases

The reply pipeline runs in three logical phases. See [Reply pipeline lifecycle](https://docs.openclaw.ai/reference/reply-lifecycle).

- **directives** — Resolve model, commands, mentions, groups, think/verbose. Files: `get-reply-directives*.ts`, `directive-handling*.ts`, `model-selection.ts`, `mentions.ts`, `groups.ts`, etc. (live in parent `reply/`.)
- **routing** — Phase 1 classification (stay/escalate/calendar) lives in `gateway/agent/run.ts` via RouterAgent (`gateway/agent/agents/classifier/`).
- **run** — Execute agent and deliver. Files: `get-reply-run.ts`, `agent-runner*.ts`, `followup-runner.ts`, `queue/`, etc. (live in parent `reply/`.)
