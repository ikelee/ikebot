# Mail Backfill Scripts (Phase 0)

Deterministic local ingestion workflow for large historical mail dumps.

## One-pass pipeline

This is now a single flow:

1. Discover mail sources.
2. Ingest + dedupe + classify importance.
3. Decode attachments from messages and save binaries.
4. Analyze docs/images (PDF text + OCR + OOXML text) inline.
5. Write deterministic stores + qmd docs for important mail.

## 1) Discover sources

```bash
bun scripts/mail/backfill-discover.ts \
  --roots "~/Library/Thunderbird/Profiles,~/Documents/Hotmail-archive" \
  --out ./tmp/mail-backfill/sources.json
```

## 2) Run one-pass backfill

```bash
bun scripts/mail/backfill-run.ts \
  --sources ./tmp/mail-backfill/sources.json \
  --out-dir ./tmp/mail-backfill \
  --qmd-dir ./tmp/mail-backfill/qmd \
  --attachments-dir ./tmp/mail-backfill/attachments/raw \
  --attachment-text-dir ./tmp/mail-backfill/attachments/text \
  --max-attachment-bytes 26214400
```

Optional bounded smoke test:

```bash
bun scripts/mail/backfill-run.ts \
  --sources ./tmp/mail-backfill/sources.json \
  --out-dir ./tmp/mail-backfill \
  --max-messages 1000
```

## 3) Verify summary

```bash
bun scripts/mail/verify-backfill.ts --out-dir ./tmp/mail-backfill
```

## Optional: analyze a standalone attachment folder

```bash
bun scripts/mail/attachment-extract.ts \
  --in-dir ./tmp/mail-backfill/attachments/raw \
  --out-dir ./tmp/mail-backfill/attachment-analysis
```

## Outputs

- `mail-events.jsonl`: append-only ingest/audit log.
- `mail-index.json`: deterministic index with importance classification and attachment analysis pointers.
- `mail-checkpoint.json`: resumable source progress/counters.
- `attachments/raw/`: decoded attachment binaries extracted from email messages.
- `attachments/text/`: extracted text (PDF/OCR/doc parsing).
- `review/attachment-skipped.jsonl`: every skipped attachment analysis record.
- `review/attachment-errors.jsonl`: every attachment or ingest error record.
- `review/risky-dropped.jsonl`: `not_important` messages that matched high-value keywords (false-negative audit list).
- `qmd/`: important-message markdown docs for semantic indexing.
