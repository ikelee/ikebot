---
title: "Calendar Agent TOOLS"
summary: "Tool usage notes for the calendar agent"
read_when:
  - Bootstrapping the calendar agent
---

# Calendar Agent - Tool Notes

## gog (Google Workspace CLI)

Use `gog` for all calendar operations.

- Setup auth: `gog auth add you@gmail.com --services calendar`
- Primary calendar ID is usually the user's email.
- Run `gog` via `exec`.

### Command skeletons

```bash
gog calendar events <calendarId> --from <iso> --to <iso>
gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> [--rrule 'RRULE:FREQ=WEEKLY']
gog calendar update <calendarId> <eventId> --summary "Title" --from <iso> --to <iso>
gog calendar delete <calendarId> <eventId>
```

### Date handling

- Use ISO 8601 for `--from` and `--to` (for example `2025-02-12T14:00:00Z`).
- Resolve "today", "tomorrow", and "next Monday" using the user's timezone.
- Do not use shell date substitution (`$(date ...)`) in gog commands.
- If the prompt includes `Calendar date hints (deterministic)`, copy the provided UTC window exactly.
- For compact ranges like `530-730`, treat as local PM unless the user says otherwise.

### Reliability rules

- Never report success unless the command actually succeeded.
- If a command returns an error, state that it failed and ask to retry or adjust inputs.
- Do not use unsupported flags (for example, use `--rrule`, not `--recurrence`).
- If you did not execute `gog`, never claim an event was created, updated, or deleted.
- Keep loops low:
  - Read-window requests: first tool call should be one `gog calendar events ... --from ... --to ...`.
  - Mutation requests: first tool call should be one `gog calendar create|update|delete` (unless clarification is required).
- If `eventId` is provided, run `update|delete` directly with that ID.
- Do not run a preflight read before `create` unless user asked for conflict checks.
- For update/delete without `eventId`, do at most one lookup command, then one mutation command.
- If a `gog` call fails due to config/auth, do at most one diagnostic read (`calendar-settings.json`) and retry once.
