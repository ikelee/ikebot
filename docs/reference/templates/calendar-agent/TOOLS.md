---
title: "Calendar Agent TOOLS"
summary: "Tool usage notes for the calendar agent"
read_when:
  - Bootstrapping the calendar agent
---

# Calendar Agent - Tool Notes

## gog (Google Workspace CLI)

Use `gog` for all calendar operations. Ensure it is installed and authenticated:

- Setup: `gog auth add you@gmail.com --services calendar`
- Primary calendar ID is usually the user's email (e.g. `user@gmail.com`)

### Commands

**List events:**

```
gog calendar events <calendarId> --from <iso> --to <iso>
```

Example: `gog calendar events user@gmail.com --from 2025-02-12T00:00:00Z --to 2025-02-13T00:00:00Z`

**Create event:**

```
gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>
```

**Update event:**

```
gog calendar update <calendarId> <eventId> --summary "New Title" --from <iso> --to <iso>
```

**List calendars / colors:**

```
gog calendar colors
```

### Date handling

- Use ISO 8601 for --from and --to (e.g. 2025-02-12T14:00:00Z)
- Resolve "today", "tomorrow", "next Monday" using the user's timezone
- Default timezone: UTC unless user specifies

### exec

You run gog via the exec tool. Ensure `gog` is in the agent's exec allowlist (tools.exec.allow or safeBins).
