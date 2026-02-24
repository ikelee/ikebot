# Mail Agent V2 Design (Ingestion + Digest + Retrieval)

## Goals

1. Read new emails continuously, summarize them, and store durable records.
2. Send morning and night email digests automatically.
3. Support fast "find me X" retrieval (ticket, receipt, flight, invoice, etc.) from indexed email data.

Scale target:

- 58k+ emails in storage.
- Attachments include PDFs/images/docs that require extraction.

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

At-scale requirement:

- Ingestion must be idempotent and resumable by `historyId` checkpoint.
- Never block ingest on enrichment.

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

For 58k+ scale, migrate from flat JSON index to memory backend:

- Use `gateway/infra/memory` search manager (`qmd` preferred, builtin fallback).
- Keep `mail-events.jsonl` as audit/source-of-truth event log.
- Store searchable email/attachment text as memory documents/chunks.
- Keep lightweight operational state in JSON:
  - `mail-checkpoint.json` (`lastHistoryId`, ingest watermark)
  - `mail-jobs.json` (pending/completed enrichment tasks)

Design principle:

- `mail-events.jsonl` is source of truth.
- Search index is rebuildable from events + extracted text/entities.

## 3) Query/Retrieval Path

When user asks "find my X":

1. Deterministic lookup in `mail-index.json` first.
2. If confidence high, return result directly with short proof fields (sender, subject, date).
3. If low confidence, run one targeted `gog gmail messages search ...` call to refresh and re-index.
4. Return concise answer + optional follow-up question only if still ambiguous.

Loop target:

- Typical retrieval should be <=2 model calls and <=1 tool call.

Large-mailbox optimization:

- Two-stage retrieval:
  - Stage A: deterministic filters (sender/date/subject/entity).
  - Stage B: semantic retrieval only on narrowed candidates.
- Keep result caps strict (top-k) to avoid prompt bloat.

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

Attachment/multimodal extraction:

- PDFs: text extraction first, image render fallback for scanned docs.
- Images/receipts/tickets: OCR + entity extraction job writes normalized entities.
- Persist extracted text/entities linked by:
  - `messageId`
  - `attachmentId`
  - `contentHash` (dedupe).

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
- large dataset replay test (tens of thousands synthetic records) validating latency + correctness.

Live tests (opt-in):

- real `gog` account with safe label/filter, no destructive actions.

## 9) Phase 0 Local Backfill Workflow (Thunderbird -> Mail Store)

Purpose:

- Bootstrap the entire historical mailbox from local Thunderbird data before live Gmail webhook ingest.
- Extract text from documents/images and gate semantic indexing by importance.
- Preserve everything in deterministic stores; only skip noisy content from semantic index.

Execution model:

- Run as a deterministic batch job from `scripts/`.
- Idempotent and resumable with checkpoints.
- No LLM required for correctness during Phase 0.

Proposed script layout:

- `scripts/mail/backfill-discover.ts`
  - Scans Thunderbird profile/export roots.
  - Detects `mbox` files, `maildir` folders (`cur/new`), and standalone `.eml`.
- `scripts/mail/backfill-run.ts`
  - Main one-pass orchestrator:
    - parse -> normalize -> dedupe
    - classify importance
    - extract attachment binaries
    - extract attachment text/OCR
    - write index/events/qmd/review files.
- `scripts/mail/attachment-extract.ts`
  - Optional standalone extractor for attachment folders already on disk.
- `scripts/mail/verify-backfill.ts`
  - Reports counts, failures, dedupe ratio, and confidence checks.

Inputs:

- Source roots passed to discover (`--roots`), commonly:
  - Thunderbird profiles
  - local archive folders in `~/Documents/*`
- `backfill-run` takes discovered source file via `--sources`.

Outputs:

- `mail-events.jsonl` (append-only, all messages/events)
- `mail-index.json` (deterministic materialized index; includes important + non-important metadata)
- `mail-checkpoint.json` (per-source cursors, last run watermark, counters)
- `qmd/emails/important/*.md` (semantic docs for important messages)
- `attachments/raw/<recordId>/*` (decoded attachment binaries)
- `attachments/text/*.txt` (extracted attachment text/OCR output)
- `attachment-analysis-summary.json` (tool detection + attachment extraction config)
- `review/attachment-skipped.jsonl` (all skipped attachment analyses)
- `review/attachment-errors.jsonl` (all attachment/parser errors)
- `review/risky-dropped.jsonl` (not-important messages that matched high-value keywords; false-negative audit list)

`mail-index.json` per-message record includes:

- Message metadata (`messageId`, sender, subject, date, folder/source)
- classification (`importance`, `importanceReasons`)
- attachment linkage (`attachments[]` with file path, text path, analysis status)

Backfill stages:

1. Discover sources
   - Enumerate mailbox inputs and create stable source IDs.
   - Record per-source fingerprint (`path`, `mtime`, `size`, optional hash).
2. Parse messages
   - Read RFC822 content and normalize core fields (`messageId`, `threadId`, sender, recipients, subject, dates, labels/folder).
   - Capture attachment metadata (`filename`, MIME, size, attachmentId, contentHash).
3. Dedupe and upsert
   - Primary key: RFC `Message-ID`.
   - Fallback key: deterministic content hash when `Message-ID` missing.
   - Preserve provenance across accounts/folders (hotmail + gmail duplicates collapse into one logical record with multiple sources).
4. Extract attachment content
   - Document-first extraction:
     - PDFs: `pdftotext` (Poppler) first; OCR fallback for scanned docs.
     - Office docs: extract text via deterministic parsers/tooling.
     - Plain text/CSV/JSON/XML: direct text parse.
   - Image extraction:
     - OCR via `tesseract`.
   - Persist extracted text + metadata linked by `messageId`, `attachmentId`, `contentHash`.
5. Importance classification (high recall)
   - Goal: keep anything remotely important.
   - `important=true` when strong signals appear:
     - e-transfer / Interac, receipts/invoices, tax/legal, recruiter/job, realtor, booking/confirmation, DocuSign
     - attachment present
     - human-thread indicators (`In-Reply-To`/`References`) when sender does not look bulk
   - `not_important=true` on strong bulk/promo/newsletter signals:
     - unsubscribe headers/body markers, bulk sender/domain patterns, promo subject patterns
     - calendar birthday notifications are explicitly downgraded.
   - false-negative guardrail:
     - dropped messages that still match high-value keywords are written to `review/risky-dropped.jsonl`.
   - Always store classification reason codes (for review and tuning).
6. Write storage layers
   - Always append event row to `mail-events.jsonl`.
   - Always upsert compact deterministic record in `mail-index.json`.
   - qmd semantic documents are written during ingestion for:
     - important messages
     - extracted attachment text linked to important messages.
   - skipped/error review logs are written during ingestion for audit.
7. Checkpoint and resume
   - Persist per-source cursor after each batch.
   - Resume safely after interruption without duplicate output rows/chunks.

Tooling and dependencies (Phase 0 baseline):

- Runtime/orchestration:
  - TypeScript scripts in `scripts/mail/*` run via Bun.
- Message parsing:
  - Robust RFC822 parser for headers/body/attachments.
- Document/image extraction:
  - `pdftotext` (Poppler) for text PDFs.
  - `tesseract` for OCR fallback and image OCR.
  - Lightweight deterministic text extractors for common doc/text formats.
- Index/memory:
  - `mail-index.json` for deterministic queries.
  - qmd memory backend for semantic retrieval.

Operational controls:

- Batch size controls for message parse and extraction workers.
- Max attachment bytes per file/job with skip + reason logging.
- Skip/error review files for attachment processing.
- Risky-drop review file for false-negative triage.

Post-run audit checklist:

1. Core run summary:
   - Check `processed`, `important`, `not_important`, `failed` from `backfill-run` output.
2. Deterministic integrity:
   - Run `scripts/mail/verify-backfill.ts` and confirm totals align with run summary.
3. Attachment extraction health:
   - Review `attachment-analysis-summary.json` (tool detection: `pdftotext`, `tesseract`, `unzip`).
   - Review counts and samples from:
     - `review/attachment-skipped.jsonl`
     - `review/attachment-errors.jsonl`
4. Importance quality:
   - Spot-check:
     - random `not_important` rows
     - random `important` rows
   - Treat every row in `review/risky-dropped.jsonl` as manual review candidates.
5. Semantic coverage:
   - Confirm qmd docs exist under `qmd/emails/important`.
   - Sample retrieval quality for high-value requests (receipt/tax/booking/interview).

Acceptance criteria for Phase 0:

- Backfill can process full local mailbox and resume safely after interruption.
- Every parsed message appears in `mail-events.jsonl` and `mail-index.json`.
- Attachment extraction writes explicit `ok`/`skipped`/`error` markers with review logs.
- Importance gate keeps high-value mail while suppressing obvious newsletter/promo noise from semantic index.
- Retrieval can answer key historical queries with evidence fields.

## 10) Phased Implementation

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

- Add advanced reranking and stricter budget controls for very large stores.

## 11) Assumptions

- Primary initial target is one Gmail account per mail agent workspace.
- Cross-account retrieval can be added by namespacing indexes per account.
- Accuracy first: never claim an email exists unless found in index or fresh `gog` query.

## 12) Operational Constraints for 58k+

- Indexing mode:
  - Incremental updates continuously.
  - Backfills run in bounded batches with resume checkpoints.
- Re-index strategy:
  - Nightly low-priority compaction/rebuild windows.
  - Never block user queries on rebuild.
- Storage lifecycle:
  - Keep metadata long-term.
  - Tier/prune raw attachment blobs by policy after extraction.
- Safety:
  - User-facing answers include evidence fields (sender/subject/date) for high-stakes lookups.
