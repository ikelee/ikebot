---
title: "Reminders Agent TOOLS"
summary: "Tool usage notes for the reminders agent"
read_when:
  - Bootstrapping the reminders agent
---

# Reminders Agent - Tool Notes

## cron

Use the cron tool to schedule reminders. When scheduling:

- Write systemEvent text that will read like a reminder when it fires
- Include recent context in the reminder text if the gap between setting and firing is long
- For one-shot: use appropriate schedule (e.g. "in 2 hours" = offset from now)

## read / write

Use read/write to maintain reminders.json (or similar) in the workspace for:

- Listing all reminders
- Tracking what's been created
- User-editable state

Store at workspace root: `reminders.json` or `memory/reminders.json`.
