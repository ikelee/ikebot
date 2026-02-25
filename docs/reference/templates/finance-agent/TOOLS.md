---
title: "Finance Agent TOOLS"
summary: "Tool usage notes for the finance agent"
read_when:
  - Bootstrapping the finance agent
---

# Finance Agent - Tool Notes

## read / write

Use read/write to maintain:

- `spendings.json`
- `goals.json`
- `reimbursements.json`
- `history/weekly-YYYY-WW.json` (raw extraction + confirmations)
- `history/audit-YYYY-WW.json` (weekly rollup + guidance)
- `history/transactions.jsonl` (append-only normalized transaction ledger)
- `history/weekly_summaries.jsonl` (append-only weekly summary ledger)

You may only access files in the workspace allowlist (`*.json`, `history/`).

### Spendings structure

```json
{
  "spendings": [
    {
      "id": "txn_2026-02-12_whole_foods_45_99",
      "date": "2026-02-12",
      "amount": 45.99,
      "merchant": "Whole Foods",
      "description": "Whole Foods",
      "category": "groceries",
      "source": "manual",
      "confidence": 1.0
    }
  ]
}
```

For screenshot entries set:

- `source: "screenshot"`
- `confidence`: between `0` and `1`
- `screenshotRef`: image filename or short ID

### Goals structure (for purchase advice)

```json
{
  "goals": {
    "monthlyBudget": 3000,
    "categoryLimits": {
      "groceries": 500,
      "dining": 200,
      "transport": 150,
      "entertainment": 100
    },
    "savingsTarget": 500
  }
}
```

### Reimbursements structure

```json
{
  "reimbursements": [
    {
      "id": "reimb_costco_2026-02-10",
      "spendingId": "txn_2026-02-10_costco_180_50",
      "merchant": "Costco",
      "totalAmount": 180.5,
      "owedBy": [
        {
          "name": "Jiwan",
          "amount": 40.0,
          "reminderCreated": true,
          "reminderRef": "cron:abc123"
        },
        {
          "name": "Tanay",
          "amount": 40.0,
          "reminderCreated": true,
          "reminderRef": "cron:def456"
        }
      ],
      "totalOwed": 80.0,
      "status": "pending"
    }
  ]
}
```

Store at workspace root: `spendings.json`, `goals.json`, `reimbursements.json`. Use `history/` for weekly extraction and audits.

## exec (local OCR only)

Use `exec` with `tesseract` to extract text from statement screenshots. Do not use cloud vision APIs.

Example command pattern:

```bash
tesseract /absolute/path/to/screenshot.png stdout --psm 6
```

If needed, try a fallback OCR mode:

```bash
tesseract /absolute/path/to/screenshot.png stdout --psm 4
```

Screenshot ingestion workflow:

1. Run local OCR on each screenshot with `tesseract`.
2. Parse OCR text into transaction candidates (date, merchant, amount, notes).
3. Infer `source` (card/account) from statement headers, card last4, or account labels when present.
4. Infer `spender` (owner vs authorized user) from cardholder/member name markers when present.
5. Assign confidence for each row and each inferred field.
6. Show an itemized confirmation list to the user before writing final records.
7. Only after user confirmation: write normalized rows to `spendings.json`.
8. Write extraction details and unresolved questions to `history/weekly-YYYY-WW.json`.

### Required inferred fields per spending

For each spending candidate, attempt to infer:

- `source`: card/account label (for internal storage)
- `spender`: normalized person name if present, else `"unknown"`
- `category`: one of the standard categories below

Do not block ingestion if inference is uncertain. Mark low confidence and ask.

## sessions_spawn / sessions_list

Use `sessions_spawn` to hand off reminder creation to the reminders agent when reimbursements are needed.

## Logging a purchase

When the user says "log a purchase of $50 for groceries":

1. Parse amount, category, description
2. Read current spendings.json
3. Append the new entry
4. Write back

If the user includes split intent (for example "split this with Jiwan and Tanay"), also create/update reimbursement records.

### Purchase advice ("is it wise to buy X for $Y?")

1. Read spendings.json and goals.json
2. Sum spending this month by category (or total)
3. Compare requested amount to: remaining budget, category limit, typical spend
4. Reply with clear yes/no/maybe and reasoning (e.g. "You have $80 left in dining; $45 would leave $35 for the rest of the month")

### Weekly/category summary

When the user asks "how much did I spend this week" or "spending by category", include both gross and net:

1. Read spendings.json
2. Read reimbursements.json
3. Gross: sum all spendings in range
4. Net: subtract only reimbursement amounts where `reminderCreated=true`
5. Sum by category (best effort category assignment if missing)
6. Write weekly audit to `history/audit-YYYY-WW.json`
7. Present clearly (e.g. bullets, no markdown tables for messaging)

When the user says "process these spendings", use this response structure:

1. `Week summary` (date range, gross, reimbursable, net)
2. `By category` (grouped list of transactions) with per-category subtotal
3. `Not mine` (all transactions inferred to be non-owner spend) with subtotal
4. `Needs confirmation` (low-confidence source/spender/category/amount/date)
5. `Weekly total` line at the bottom (`gross`, `reimbursable`, `net`)
6. `Week-over-week` comparison vs previous calendar week (`higher/lower`, absolute delta, percent delta)
7. `Next edits` prompt ("Reply with fixes, recategorizations, or split reminders")

After each processed week, append:

- each normalized transaction as one line in `history/transactions.jsonl` with required `date` (`YYYY-MM-DD`)
- one weekly rollup object in `history/weekly_summaries.jsonl` with required `weekStartDate`, `weekEndDate`, and `generatedAt`

Do not rewrite JSONL history files; append new lines only.
Only append JSONL rows after explicit user confirmation of extracted spendings (including any user-requested corrections). Do not append immediately after OCR.

### Split reminders via reminders agent

If the user says something like "that Costco run, remind me to split it with Jiwan and Tanay":

1. Identify matching spending entry (ask a clarifying question if ambiguous).
2. Use `sessions_spawn` to hand off to reminders agent with a concrete task to create reminder(s) for each person.
3. Capture returned reference(s) in `reimbursements.json`.
4. Only count these as subtractable from weekly net after reminder creation succeeds.

If reminders handoff fails, keep reimbursement entries with `reminderCreated=false` and do not subtract from net.

### Guidance and follow-up reminders

When weekly audits are complete:

1. Give breakdown by category and biggest drivers.
2. Give 3-5 practical guidance bullets.
3. If helpful, create reminder handoffs for future spend controls (for example "check dining budget Thursday").

### Categories

Use best-effort categories:

- groceries
- dining
- food (when unclear between groceries/dining)
- music_hobby
- transport
- travel
- utilities
- shopping
- fun
- entertainment
- health
- random
- other

Prefer explicit merchant cues. If category is uncertain, mark and ask.
