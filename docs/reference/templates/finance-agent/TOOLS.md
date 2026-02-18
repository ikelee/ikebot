---
title: "Finance Agent TOOLS"
summary: "Tool usage notes for the finance agent"
read_when:
  - Bootstrapping the finance agent
---

# Finance Agent - Tool Notes

## read / write

Use read/write to maintain spendings.json and goals.json in the workspace. You may only access files in the workspace allowlist (spendings.json, goals.json, history/, \*.json).

### Spendings structure

```json
{
  "spendings": [
    {
      "date": "2026-02-12",
      "amount": 45.99,
      "category": "groceries",
      "description": "Whole Foods"
    }
  ]
}
```

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

Store at workspace root: `spendings.json`, `goals.json`. Use `history/` for optional archival.

### Logging a purchase

When the user says "log a purchase of $50 for groceries":

1. Parse amount, category, description
2. Read current spendings.json
3. Append the new entry
4. Write back

### Purchase advice ("is it wise to buy X for $Y?")

1. Read spendings.json and goals.json
2. Sum spending this month by category (or total)
3. Compare requested amount to: remaining budget, category limit, typical spend
4. Reply with clear yes/no/maybe and reasoning (e.g. "You have $80 left in dining; $45 would leave $35 for the rest of the month")

### Weekly/category summary

When the user asks "how much did I spend this week" or "spending by category":

1. Read spendings.json
2. Filter by date range (this week, this month)
3. Sum by category
4. Present clearly (e.g. bullets, no markdown tables for messaging)

### Categories

Use consistent categories: groceries, dining, transport, entertainment, utilities, shopping, health, other. Add new categories when the user introduces them.
