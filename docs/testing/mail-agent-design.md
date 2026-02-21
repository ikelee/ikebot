# Mail Agent V2 Design (Ingestion + Digest + Retrieval)

## Goals

1. Read new emails continuously, summarize them, and store durable records.
2. Send morning and night email digests automatically.
3. Support fast "find me X" retrieval (ticket, receipt, flight, invoice, etc.) from indexed email data.

## Existing Building Blocks We Already Have

- Gmail ingress watcher:
  - `gateway/extensibility/hooks/gmail-watcher.ts`
  - Uses `gog gmail watch start` + `gog gmail watch serve`.
- Gmail hook runtime config:
  - `gateway/extensibility/hooks/gmail.ts`
- Hook mapping and agent wake path:
  - `/hooks/gmail` mapping in config/docs.
- Scheduled jobs:
  - `gateway/cron/*` with `wakeMode`, `deliver`, `channel`, `to`.
- Mail agent shell:
  - `gateway/agent/agents/mail/*`
  - Current scope is read/search via `gog` and simple onboarding.

## Proposed Architecture

## 1) Ingestion Pipeline

Ingress source:

- Gmail watch event -> `gog gmail watch serve` -> `/hooks/gmail`.

Two-stage ingest:

1. Deterministic ingest worker (non-LLM):
   - Parses incoming payload.
   - Normalizes message metadata.
   - Upserts index files.
2. Optional summarization pass (LLM, bounded):
   - Generates short per-message summary.
   - Adds extraction tags for high-value entities (order number, flight code, due date, amount).

Why this split:

- Deterministic ingest means no data loss if model is slow/fails.
- LLM only enriches records, not responsible for core storage correctness.

## 2) Storage Model (Agent Workspace)

Keep existing files, add event + index files.

Existing:

- `mail-settings.json`
- `mail-notes.txt`
- `mail-memo-{id}.md`

New:

- `mail-events.jsonl`
  - Immutable append-only event log (ingested, updated labels, archived, summary enriched).
- `mail-index.json`
  - Materialized index for fast lookup by:
    - `messageId`
    - `threadId`
    - `from`
    - `subject tokens`
    - `date`
    - `labels`
    - extracted entities (`ticket`, `receipt`, `flight`, `invoice`, `tracking`, `amount`).
- `mail-digests.jsonl`
  - Digest history (morning/night windows, message IDs included, summary text, sent channel).

Design principle:

- `mail-events.jsonl` is source of truth.
- `mail-index.json` is rebuildable from events.

## 3) Query/Retrieval Path

When user asks "find my X":

1. Deterministic lookup in `mail-index.json` first.
2. If confidence high, return result directly with short proof fields (sender, subject, date).
3. If low confidence, run one targeted `gog gmail messages search ...` call to refresh and re-index.
4. Return concise answer + optional follow-up question only if still ambiguous.

Loop target:

- Typical retrieval should be <=2 model calls and <=1 tool call.

## 4) Digest Scheduling

Two cron jobs per user/account:

- Morning digest (example: 07:30 local)
- Night digest (example: 21:00 local)

Digest generation flow:

1. Pull unseen/new messages since last digest boundary from `mail-index.json`.
2. Build grouped summary by category:
   - urgent/action required
   - finance/receipts
   - travel/events
   - newsletters/no-action
3. Persist output in `mail-digests.jsonl`.
4. Deliver through existing outbound channel (`deliver: true`, `channel`, `to`).

If no new mail:

- Send short "No new important mail" message (configurable).

## 5) Agent Responsibilities

Mail agent should handle:

- ad-hoc email questions,
- one-shot manual summary,
- retrieval from local index,
- optional targeted refresh via `gog`.

Mail agent should not own:

- webhook parsing/storage correctness (ingest worker owns this),
- cron scheduling engine (already in `gateway/cron`).

## 6) Tooling/PI Config Changes

Current mail PI config is `exec-only`. For V2, mail agent should be able to read local index/state.

Recommended:

- Add `read` tool access for mail agent.
- Keep `exec` allowlisted to `gog`.
- Avoid broad write access from the agent for core index files. Prefer deterministic writer path in ingest worker.

Optional:

- Allow `write` only for `mail-memo-*.md` and user notes, not for canonical index/events.

## 7) Entity Extraction Contract

Per message, normalized optional fields:

- `kind`: `ticket | receipt | flight | invoice | tracking | reminder | generic`
- `entities`:
  - `orderId`
  - `ticketId`
  - `flightNumber`
  - `merchant`
  - `amount`
  - `currency`
  - `dueDate`

Use this to answer natural requests quickly:

- "my X ticket"
- "that Amazon receipt"
- "Francis flight number"

## 8) Testing Plan

Unit tests:

- payload -> normalized event
- reducer/event-log -> index rebuild
- entity extraction parser (deterministic patterns)
- digest window slicing and category grouping

Agent-level tests:

- "find my receipt" against seeded index
- "summarize today\'s new mail"
- fallback path that does one `gog` refresh when index miss occurs

E2E tests:

- `/hooks/gmail` payload ingested -> index updated -> query answer returns from index
- morning/night cron run emits digest and records entry in `mail-digests.jsonl`

Live tests (opt-in):

- real `gog` account with safe label/filter, no destructive actions.

## 9) Phased Implementation

Phase 1:

- Add event+index files and deterministic ingest worker.
- Keep current agent behavior mostly unchanged.

Phase 2:

- Add morning/night digest generation and cron setup helper.
- Add digest persistence.

Phase 3:

- Add high-value retrieval entities and confidence-based refresh strategy.
- Tighten loop/call budgets.

Phase 4:

- Add optional vector/hybrid retrieval if mailbox size grows beyond simple JSON index performance.

## 10) Assumptions

- Primary initial target is one Gmail account per mail agent workspace.
- Cross-account retrieval can be added by namespacing indexes per account.
- Accuracy first: never claim an email exists unless found in index or fresh `gog` query.
